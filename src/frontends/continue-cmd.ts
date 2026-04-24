// frontends/continue-cmd.ts
// Session restore from model_responses logs.
// Ported from Python's continue-cmd, enhanced with rich session previews.
// Reads model response log files, extracts history blocks,
// detects rounds / model / first user text, and provides UI message extraction for replay.

import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve, basename, extname } from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionEntry {
  path: string;
  mtime: Date;
  relativeTime: string;
  roundCount: number;
  firstUserText: string;
  modelName: string;
  summary: string;
}

export interface UIMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp?: string;
}

// ─── Time formatting ────────────────────────────────────────────────────────

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay > 7) return date.toISOString().slice(0, 10);
  if (diffDay > 1) return `${diffDay}d ago`;
  if (diffDay === 1) return 'yesterday';
  if (diffHour > 1) return `${diffHour}h ago`;
  if (diffHour === 1) return '1h ago';
  if (diffMin > 1) return `${diffMin}m ago`;
  if (diffMin === 1) return '1m ago';
  return 'just now';
}

// ─── Session listing ────────────────────────────────────────────────────────

/**
 * List recent session files from the model_responses log directory.
 * Extracts enriched session metadata (history, rounds, first user text, model).
 * Returns up to `count` entries sorted by modification time (newest first).
 */
export function listRecentSessions(logDir: string, count: number = 10): SessionEntry[] {
  const entries: SessionEntry[] = [];

  try {
    const files = readdirSync(logDir)
      .filter(f => extname(f) === '.json' || extname(f) === '.txt')
      .map(f => ({
        name: f,
        path: resolve(logDir, f),
        mtime: statSync(resolve(logDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, count * 2); // Read a few more to account for files without history

    for (const file of files) {
      if (entries.length >= count) break;

      try {
        const content = readFileSync(file.path, 'utf-8');
        const metadata = extractSessionMetadata(content, file.path, file.mtime);

        if (metadata.summary || metadata.firstUserText) {
          entries.push(metadata);
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Log directory may not exist yet
  }

  return entries;
}

// ─── Session metadata extraction ────────────────────────────────────────────

/**
 * Extract rich metadata from a session file for preview.
 * Detects: round count, first user text, model name, history summary, relative time.
 */
function extractSessionMetadata(
  content: string,
  path: string,
  mtime: Date,
): SessionEntry {
  const summary = extractHistorySummary(content);
  const roundCount = countRounds(content);
  const firstUserText = extractFirstUserText(content);
  const modelName = extractModelName(content);

  return {
    path,
    mtime,
    relativeTime: formatRelativeTime(mtime),
    roundCount,
    firstUserText,
    modelName,
    summary,
  };
}

/**
 * Count the number of LLM turns (=== Prompt === segments) in the log.
 */
function countRounds(content: string): number {
  const matches = content.match(/=== Prompt ===/g);
  return matches ? matches.length : 0;
}

/**
 * Extract the first user prompt from the session log.
 * Looks for the first === USER === segment or the first meaningful query.
 */
function extractFirstUserText(content: string): string {
  // Try === USER === segment first
  const userMatch = content.match(/=== USER ===\n([\s\S]*?)(?:\n=== |$)/);
  if (userMatch) {
    const text = userMatch[1].trim();
    if (text.length > 5) return text.slice(0, 200);
  }

  // Try JSON array format – first user message
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      for (const msg of data) {
        if (msg?.role === 'user') {
          const text = extractTextFromMessage(msg);
          if (text && text.length > 3) return text.slice(0, 200);
        }
      }
    }
  } catch { /* fall through */ }

  // Try first meaningful line after a header
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 10 && !trimmed.startsWith('===') && !trimmed.startsWith('{')) {
      return trimmed.slice(0, 200);
    }
  }

  return '';
}

/**
 * Try to detect the model name from the session log.
 */
function extractModelName(content: string): string {
  // Look for "model" in JSON blocks
  const modelRe = /"model"\s*:\s*"([^"]+)"/g;
  const matches = [...content.matchAll(modelRe)];
  if (matches.length > 0) {
    // Return the most common model name
    const counts = new Map<string, number>();
    for (const m of matches) {
      const name = m[1];
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [name, c] of counts) {
      if (c > bestCount) { best = name; bestCount = c; }
    }
    return best;
  }

  // Try plain text model patterns
  const plainRe = /model[:\s]+([a-zA-Z0-9._-]+)/i;
  const pm = content.match(plainRe);
  if (pm) return pm[1];

  return '';
}

// ─── History extraction ─────────────────────────────────────────────────────

/**
 * Extract the last <history> block from a session file.
 */
function extractHistorySummary(content: string): string {
  // Try JSON first (new format)
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      // Find last history-containing message
      for (let i = data.length - 1; i >= 0; i--) {
        const msg = data[i];
        if (msg && typeof msg === 'object') {
          const text = extractTextFromMessage(msg);
          if (text && /<history>/i.test(text)) {
            return extractHistoryBlock(text);
          }
        }
      }
    }
  } catch {
    // Not JSON, try text format
  }

  // Try raw text search for <history>...</history>
  return extractHistoryBlock(content);
}

/**
 * Extract the history block content from a string.
 */
function extractHistoryBlock(text: string): string {
  const match = text.match(/<history>([\s\S]*?)<\/history>/i);
  if (match) {
    return match[1].trim().slice(0, 500); // Truncate to reasonable summary length
  }
  return '';
}

/**
 * Extract text content from a message object.
 */
function extractTextFromMessage(msg: Record<string, unknown>): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<{ type: string; text?: string }>)
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }
  return '';
}

// ─── Session loading ────────────────────────────────────────────────────────

/**
 * Read a full session file and return its last <history> block content.
 */
export function loadSession(path: string): string {
  const content = readFileSync(path, 'utf-8');

  // Try JSON format
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      for (let i = data.length - 1; i >= 0; i--) {
        const text = extractTextFromMessage(data[i]);
        if (text && /<history>/i.test(text)) {
          return extractHistoryBlock(text);
        }
      }
    }
  } catch {
    // Fall through to text extraction
  }

  return extractHistoryBlock(content);
}

// ─── UI message extraction for replay ───────────────────────────────────────

/**
 * Extract structured UI messages from a session file for replay.
 * Parses both JSON-array format and text segment format.
 * Useful for session replay in chat interfaces.
 */
export function extractUIMessages(pathOrContent: string): UIMessage[] {
  let content: string;
  try {
    content = readFileSync(pathOrContent, 'utf-8');
  } catch {
    // Assume it's already raw content
    content = pathOrContent;
  }

  const messages: UIMessage[] = [];

  // Try JSON format first
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      for (const msg of data) {
        if (!msg || typeof msg !== 'object') continue;
        const role = (msg.role as string)?.toLowerCase();
        if (!role || !['user', 'assistant', 'tool', 'system'].includes(role)) continue;

        const text = extractTextFromMessage(msg);
        if (text) {
          messages.push({
            role: role as UIMessage['role'],
            content: text,
            timestamp: msg.timestamp as string | undefined,
          });
        }
      }
      return messages;
    }
  } catch { /* fall through to text parsing */ }

  // Parse text segment format: === USER === / === ASSISTANT === / === SYSTEM ===
  const segmentRe = /^=== (USER|ASSISTANT|SYSTEM|TOOL) ===\s*(.*?)$/gm;
  let lastIndex = 0;
  let currentRole: UIMessage['role'] | null = null;
  let currentTimestamp: string | undefined;
  let currentContent = '';

  let match;
  while ((match = segmentRe.exec(content)) !== null) {
    // Save previous segment
    if (currentRole) {
      const text = currentContent.trim();
      if (text) {
        messages.push({
          role: currentRole,
          content: text,
          timestamp: currentTimestamp,
        });
      }
    }

    currentRole = match[1].toLowerCase() as UIMessage['role'];
    currentTimestamp = match[2]?.trim() || undefined;
    currentContent = '';

    lastIndex = match.index + match[0].length;
  }

  // Last segment
  if (currentRole) {
    const remaining = content.slice(lastIndex);
    const text = remaining.trim();
    if (text) {
      messages.push({
        role: currentRole,
        content: text,
        timestamp: currentTimestamp,
      });
    }
  }

  return messages;
}

// ─── Rich session preview formatting ────────────────────────────────────────

/**
 * Format a rich session entry for display.
 */
export function formatSessionEntry(entry: SessionEntry, index?: number): string {
  const lines: string[] = [];

  const header = index !== undefined
    ? `[${index + 1}] ${entry.relativeTime}`
    : `[${entry.relativeTime}]`;

  lines.push(header);
  lines.push(`  File:    ${basename(entry.path)}`);
  lines.push(`  Rounds:  ${entry.roundCount || '?'}`);
  if (entry.modelName) lines.push(`  Model:   ${entry.modelName}`);
  if (entry.firstUserText) {
    lines.push(`  Query:   ${entry.firstUserText.slice(0, 100)}`);
  }
  if (entry.summary) {
    lines.push(`  History: ${entry.summary.slice(0, 150)}`);
  }

  return lines.join('\n');
}

/**
 * Format a list of session entries for terminal display.
 */
export function formatSessionList(entries: SessionEntry[]): string {
  if (!entries.length) return 'No previous sessions found.';

  const lines = ['\n=== Recent Sessions ===\n'];
  for (let i = 0; i < entries.length; i++) {
    lines.push(formatSessionEntry(entries[i], i));
    lines.push('');
  }
  return lines.join('\n');
}
