/**
 * Default reply routing for this session — written by the host on every
 * container wake (see src/session-manager.ts `writeSessionRouting`).
 *
 * Read by the MCP tools as the default destination for outbound messages
 * when the agent doesn't specify an explicit `to`. This is what makes
 * "agent replies in the thread it's currently in" work: the router strips
 * or preserves thread_id based on the adapter's thread support, and we
 * just read the fixed routing the host committed for this session.
 */
import { getInboundDb } from './connection.js';

export interface SessionRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
  /** 1 = host stamped this session as a task-series session. */
  is_task: 0 | 1;
}

export function getSessionRouting(): SessionRouting {
  const db = getInboundDb();
  try {
    const row = db
      .prepare('SELECT channel_type, platform_id, thread_id, is_task FROM session_routing WHERE id = 1')
      .get() as SessionRouting | undefined;
    if (row) return row;
  } catch {
    // is_task column may not exist yet (host predates the stamp) — retry
    // without it and derive task-ness from the thread prefix.
    try {
      const row = db
        .prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1')
        .get() as Omit<SessionRouting, 'is_task'> | undefined;
      if (row) return { ...row, is_task: row.thread_id?.startsWith('system:tasks') ? 1 : 0 };
    } catch {
      // Table may not exist on an older session DB — fall through to defaults
    }
  }
  return { channel_type: null, platform_id: null, thread_id: null, is_task: 0 };
}
