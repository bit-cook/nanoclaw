/**
 * Destination map loaded at container startup from
 * /workspace/.nanoclaw-destinations.json (written by the host on wake).
 *
 * The map is BOTH the routing table and the ACL — if a name/target
 * isn't in here, the agent can't reach it.
 */
import fs from 'fs';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

const DEST_FILE = '/workspace/.nanoclaw-destinations.json';

let cache: DestinationEntry[] = [];

export function loadDestinations(): void {
  try {
    if (!fs.existsSync(DEST_FILE)) {
      cache = [];
      return;
    }
    const raw = fs.readFileSync(DEST_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { destinations?: DestinationEntry[] };
    cache = Array.isArray(parsed.destinations) ? parsed.destinations : [];
  } catch (err) {
    console.error(`[destinations] Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    cache = [];
  }
}

export function getAllDestinations(): DestinationEntry[] {
  return cache;
}

/** Test-only: inject destinations without touching the filesystem. */
export function setDestinationsForTest(destinations: DestinationEntry[]): void {
  cache = destinations;
}

export function findByName(name: string): DestinationEntry | undefined {
  return cache.find((d) => d.name === name);
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  if (channelType === 'agent') {
    return cache.find((d) => d.type === 'agent' && d.agentGroupId === platformId);
  }
  return cache.find((d) => d.type === 'channel' && d.channelType === channelType && d.platformId === platformId);
}

/** Generate the system-prompt addendum describing destinations and syntax. */
export function buildSystemPromptAddendum(): string {
  if (cache.length === 0) {
    return [
      '## Sending messages',
      '',
      'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
    ].join('\n');
  }

  // Single-destination shortcut: the agent just writes its response normally.
  // No wrapping needed. This preserves the simple case (one user, one channel).
  if (cache.length === 1) {
    const d = cache[0];
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    return [
      '## Sending messages',
      '',
      `Your messages are delivered to \`${d.name}\`${label}. Just write your response directly — no special wrapping needed.`,
      '',
      'To mark something as scratchpad (logged but not sent), wrap it in `<internal>...</internal>`.',
      '',
      'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool.',
    ].join('\n');
  }

  const lines = ['## Sending messages', '', 'You can send messages to the following destinations:', ''];
  for (const d of cache) {
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    lines.push(`- \`${d.name}\`${label}`);
  }
  lines.push('');
  lines.push('To send a message, wrap it in a `<message to="name">...</message>` block.');
  lines.push('You can include multiple `<message>` blocks in one response to send to multiple destinations.');
  lines.push('Text outside of `<message>` blocks is scratchpad — logged but not sent anywhere.');
  lines.push('Use `<internal>...</internal>` to make scratchpad intent explicit.');
  lines.push('');
  lines.push(
    'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool with the `to` parameter set to a destination name.',
  );
  return lines.join('\n');
}
