import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import { formatMessages, extractRouting, categorizeMessage, type RoutingContext } from './formatter.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
const IDLE_END_MS = 20_000; // End stream after 20s with no SDK events

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  cwd: string;
  mcpServers: Record<string, McpServerConfig>;
  systemPrompt?: string;
  env: Record<string, string | undefined>;
  additionalDirectories?: string[];
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  let sessionId: string | undefined;
  let resumeAt: string | undefined;

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  while (true) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages().filter((m) => m.kind !== 'system');
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // Handle commands: categorize chat messages
    const adminUserId = config.env.NANOCLAW_ADMIN_USER_ID;
    const normalMessages = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') {
        normalMessages.push(msg);
        continue;
      }

      const cmdInfo = categorizeMessage(msg);

      if (cmdInfo.category === 'filtered') {
        // Silently drop — mark completed, don't process
        log(`Filtered command: ${cmdInfo.command} (msg: ${msg.id})`);
        commandIds.push(msg.id);
        continue;
      }

      if (cmdInfo.category === 'admin') {
        if (!adminUserId || cmdInfo.senderId !== adminUserId) {
          log(`Admin command denied: ${cmdInfo.command} from ${cmdInfo.senderId} (msg: ${msg.id})`);
          writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({ text: `Permission denied: ${cmdInfo.command} requires admin access.` }),
          });
          commandIds.push(msg.id);
          continue;
        }
        // Handle admin commands directly
        if (cmdInfo.command === '/clear') {
          log('Clearing session (resetting sessionId)');
          sessionId = undefined;
          resumeAt = undefined;
          writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({ text: 'Session cleared.' }),
          });
          commandIds.push(msg.id);
          continue;
        }

        // Other admin commands — pass through to agent
        normalMessages.push(msg);
        continue;
      }

      // passthrough or none
      normalMessages.push(msg);
    }

    // Mark filtered/denied command messages as completed immediately
    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    // If all messages were filtered commands, skip processing
    if (normalMessages.length === 0) {
      // Mark remaining processing IDs as completed
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text, others get XML
    const prompt = formatMessagesWithCommands(normalMessages);

    log(`Processing ${normalMessages.length} message(s), kinds: ${[...new Set(normalMessages.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      sessionId,
      resumeAt,
      cwd: config.cwd,
      mcpServers: config.mcpServers,
      systemPrompt: config.systemPrompt,
      env: config.env,
      additionalDirectories: config.additionalDirectories,
    });

    // Process the query while concurrently polling for new messages
    const processingIds = ids.filter((id) => !commandIds.includes(id));
    try {
      const result = await processQuery(query, routing, config, processingIds);
      if (result.sessionId) sessionId = result.sessionId;
      if (result.resumeAt) resumeAt = result.resumeAt;
    } catch (err) {
      log(`Query error: ${err instanceof Error ? err.message : String(err)}`);
      // Write error response so the user knows something went wrong
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${err instanceof Error ? err.message : String(err)}` }),
      });
    }

    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * Passthrough commands (e.g., /foo) are sent raw (no XML wrapping).
 * Admin commands from authorized users are formatted as system commands.
 * Normal messages get standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[]): string {
  // Check if any message is a passthrough command
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (msg.kind === 'chat' || msg.kind === 'chat-sdk') {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  sessionId?: string;
  resumeAt?: string;
}

async function processQuery(query: AgentQuery, routing: RoutingContext, config: PollLoopConfig, processingIds: string[]): Promise<QueryResult> {
  let querySessionId: string | undefined;
  let done = false;
  let lastEventTime = Date.now();

  // Concurrent polling: push follow-ups, checkpoint WAL, detect idle
  const pollHandle = setInterval(() => {
    if (done) return;

    // Skip system messages (MCP tool responses) and admin commands (need fresh query)
    const newMessages = getPendingMessages().filter((m) => {
      if (m.kind === 'system') return false;
      if (m.kind === 'chat' || m.kind === 'chat-sdk') {
        const cmd = categorizeMessage(m);
        if (cmd.category === 'admin') return false;
      }
      return true;
    });
    if (newMessages.length > 0) {
      const newIds = newMessages.map((m) => m.id);
      markProcessing(newIds);

      const prompt = formatMessages(newMessages);
      log(`Pushing ${newMessages.length} follow-up message(s) into active query`);
      query.push(prompt);

      markCompleted(newIds);
      lastEventTime = Date.now(); // new input counts as activity
    }

    // End stream when agent is idle: no SDK events and no pending messages
    if (Date.now() - lastEventTime > IDLE_END_MS) {
      log(`No SDK events for ${IDLE_END_MS / 1000}s, ending query`);
      query.end();
    }
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      lastEventTime = Date.now();
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        querySessionId = event.sessionId;
      } else if (event.type === 'result' && event.text) {
        dispatchResultText(event.text, routing);
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { sessionId: querySessionId };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.sessionId}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(`Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`);
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is normally scratchpad — logged but
 * not sent.
 *
 * Single-destination shortcut: if the agent has exactly one configured
 * destination AND the output contains zero <message> blocks, the entire
 * cleaned text (with <internal> tags stripped) is sent to that destination.
 * This preserves the simple case of one user on one channel — the agent
 * doesn't need to know about wrapping syntax at all.
 */
function dispatchResultText(text: string, routing: RoutingContext): void {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = scratchpadParts
    .join('')
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .trim();

  // Single-destination shortcut: the agent wrote plain text and has exactly
  // one destination. Send the entire cleaned text to it.
  if (sent === 0 && scratchpad) {
    const all = getAllDestinations();
    if (all.length === 1) {
      sendToDestination(all[0], scratchpad, routing);
      return;
    }
  }

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  if (sent === 0 && text.trim()) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: null,
    content: JSON.stringify({ text: body }),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
