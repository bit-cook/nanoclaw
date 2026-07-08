/**
 * One-door delivery in task sessions.
 *
 * Wiring under test (each leg goes red if its integration is deleted):
 *   1. send_message with no `to` ERRORS in a task session (session_routing
 *      thread system:tasks:*) instead of falling back to a default target.
 *   2. Final-text `<message to>` blocks are inert in a task fire — no
 *      outbound chat row, no "undelivered" nudge state.
 *   3. The fire's final text auto-appends as a `task_log` outbound row,
 *      EXCEPT when the agent already ran `ncl tasks append-log` this fire.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages, hasAppendLogRequestSince, maxSeq, writeMessageOut } from './db/messages-out.js';
import { sendMessage } from './mcp-tools/core.js';
import { autoAppendTaskLog, dispatchResultText, shouldNudgeTaskBlocks } from './poll-loop.js';
import type { RoutingContext } from './formatter.js';

function seedSessionRouting(threadId: string | null, isTask?: 0 | 1): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT,
    is_task INTEGER NOT NULL DEFAULT 0
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id, is_task) VALUES (1, ?, ?, ?, ?)',
  ).run(
    threadId ? null : 'telegram',
    threadId ? null : 'telegram:123',
    threadId,
    isTask ?? (threadId?.startsWith('system:tasks') ? 1 : 0),
  );
}

function seedDestination(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('family', 'Family', 'channel', 'telegram', 'telegram:99', NULL)`,
    )
    .run();
}

const taskRouting: RoutingContext = {
  platformId: 'ag-1',
  channelType: 'agent',
  threadId: 'system:tasks:daily-digest-a1b2',
  inReplyTo: 'fire-1',
  taskFire: true,
};

beforeEach(() => {
  initTestSessionDb();
  seedDestination();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message in a task session', () => {
  it('errors without `to` — no default-destination fallback', async () => {
    seedSessionRouting('system:tasks:daily-digest-a1b2');

    const res = (await sendMessage.handler({ text: 'hello' })) as { isError?: boolean; content: { text: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('task session');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('the host-stamped is_task flag alone drives the gate (thread_id NULL)', async () => {
    // No thread prefix to sniff — proves the flag, not the magic string,
    // is what makes the session a task session.
    seedSessionRouting(null, 1);

    const res = (await sendMessage.handler({ text: 'hello' })) as { isError?: boolean; content: { text: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('task session');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('delivers normally with an explicit `to`', async () => {
    seedSessionRouting('system:tasks:daily-digest-a1b2');

    await sendMessage.handler({ to: 'family', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('telegram:99');
  });

  it('chat sessions keep the reply-in-place default', async () => {
    seedSessionRouting(null); // normal chat routing row

    await sendMessage.handler({ text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('telegram:123');
  });
});

describe('final-text <message to> blocks in a task fire', () => {
  it('are inert — no outbound row, no undelivered flag, counted for the nudge', () => {
    const { sent, hasUnwrapped, taskBlocks } = dispatchResultText(
      '<message to="family">digest is ready</message>',
      taskRouting,
    );

    expect(sent).toBe(0);
    expect(hasUnwrapped).toBe(false); // plain text is the normal task ending — never the wrap nudge
    expect(taskBlocks).toBe(1); // but the inert block IS flagged for the task nudge
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('still deliver in non-task sessions', () => {
    const { sent, taskBlocks } = dispatchResultText('<message to="family">hi</message>', {
      ...taskRouting,
      taskFire: false,
    });

    expect(sent).toBe(1);
    expect(taskBlocks).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('nudge fires once per turn, and only in task fires with blocks', () => {
    expect(shouldNudgeTaskBlocks(true, 1, false)).toBe(true);
    expect(shouldNudgeTaskBlocks(true, 1, true)).toBe(false); // already nudged this turn
    expect(shouldNudgeTaskBlocks(true, 0, false)).toBe(false); // plain text is the normal ending
    expect(shouldNudgeTaskBlocks(false, 1, false)).toBe(false); // chat turns use the wrap nudge
  });

  it('run-log auto-append happens exactly once across a nudged turn', () => {
    const start = maxSeq();
    let nudged = false;

    // Result 1: the agent ended the fire with an inert <message> block.
    const first = dispatchResultText('<message to="family">digest</message>', taskRouting);
    const willRetry = shouldNudgeTaskBlocks(true, first.taskBlocks, nudged);
    expect(willRetry).toBe(true);
    if (!willRetry) autoAppendTaskLog('<message to="family">digest</message>', start);
    nudged = true;

    // Result 2 (post-nudge retry): plain final text → this one becomes the log.
    const second = dispatchResultText('Sent the digest to family via send_message.', taskRouting);
    const willRetry2 = shouldNudgeTaskBlocks(true, second.taskBlocks, nudged);
    expect(willRetry2).toBe(false);
    if (!willRetry2) autoAppendTaskLog('Sent the digest to family via send_message.', start);

    const rows = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").all() as {
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Sent the digest to family via send_message.');
  });
});

describe('task-fire run-log auto-append', () => {
  it('writes a task_log row from the final text', () => {
    const start = maxSeq();

    autoAppendTaskLog('Checked  the\nfeeds — nothing new.', start);

    const rows = getOutboundDb().prepare("SELECT kind, content FROM messages_out WHERE kind = 'task_log'").all() as {
      kind: string;
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Checked the feeds — nothing new.'); // whitespace collapsed
  });

  it('strips <message to> blocks — logs their inner text marked undelivered, never raw XML', () => {
    const start = maxSeq();

    autoAppendTaskLog('Digest done. <message to="family">3 new posts today</message> See you tomorrow.', start);

    const rows = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").all() as {
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    const line = JSON.parse(rows[0].content).text as string;
    expect(line).not.toContain('<message');
    expect(line).toContain('[undelivered → family] 3 new posts today');
    expect(line).toContain('Digest done.');
  });

  it('is suppressed when the agent ran append-log this fire (exactly-once)', () => {
    const start = maxSeq();
    // The ncl binary writes each CLI call as a cli_request system row.
    writeMessageOut({
      id: 'cli-1',
      kind: 'system',
      content: JSON.stringify({ action: 'cli_request', requestId: 'cli-1', command: 'tasks-append-log', args: { msg: 'done' } }),
    });
    expect(hasAppendLogRequestSince(start)).toBe(true);

    autoAppendTaskLog('final text', start);

    const rows = getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE kind = 'task_log'").all();
    expect(rows).toHaveLength(0);
  });

  it('a positional append-log invocation (dash-joined command) also suppresses', () => {
    const start = maxSeq();
    // `ncl tasks append-log "did the thing"` → command 'tasks-append-log-did-the-thing'
    writeMessageOut({
      id: 'cli-pos',
      kind: 'system',
      content: JSON.stringify({
        action: 'cli_request',
        requestId: 'cli-pos',
        command: 'tasks-append-log-did-the-thing',
        args: {},
      }),
    });

    expect(hasAppendLogRequestSince(start)).toBe(true);

    autoAppendTaskLog('final text', start);
    expect(getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE kind = 'task_log'").all()).toHaveLength(0);
  });

  it('a DEFINITIVELY failed append-log (response ok:false) does not suppress', () => {
    const start = maxSeq();
    writeMessageOut({
      id: 'cli-fail',
      kind: 'system',
      content: JSON.stringify({ action: 'cli_request', requestId: 'cli-fail', command: 'tasks-append-log', args: {} }),
    });
    // Host response frame lands in inbound messages_in with ok:false.
    getInboundDb()
      .prepare("INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES (?, ?, 'system', datetime('now'), ?)")
      .run(
        'resp-fail',
        1000,
        JSON.stringify({
          requestId: 'cli-fail',
          frame: { id: 'cli-fail', ok: false, error: { code: 'invalid-args', message: 'bad series' } },
        }),
      );

    expect(hasAppendLogRequestSince(start)).toBe(false);

    autoAppendTaskLog('final text', start);
    expect(getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE kind = 'task_log'").all()).toHaveLength(1);
  });

  it('an append-log with a still-pending response suppresses (no double-log on the success path)', () => {
    const start = maxSeq();
    writeMessageOut({
      id: 'cli-pending',
      kind: 'system',
      content: JSON.stringify({
        action: 'cli_request',
        requestId: 'cli-pending',
        command: 'tasks-append-log',
        args: {},
      }),
    });
    // No response row in inbound yet.

    expect(hasAppendLogRequestSince(start)).toBe(true);
  });

  it('append-log from BEFORE the fire does not suppress', () => {
    writeMessageOut({
      id: 'cli-old',
      kind: 'system',
      content: JSON.stringify({ action: 'cli_request', requestId: 'cli-old', command: 'tasks-append-log', args: {} }),
    });
    const start = maxSeq(); // watermark taken after the old call

    autoAppendTaskLog('final text', start);

    const rows = getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE kind = 'task_log'").all();
    expect(rows).toHaveLength(1);
  });
});
