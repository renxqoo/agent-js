// memory/session-compressor.ts
// L4 Session Compressor – parses model_response log files, extracts and deduplicates
// history blocks, compresses conversation segments, and writes compact summaries.
//
// Session log format:
//   === Prompt === 2025-01-01 12:00:00
//   <content>
//   === Response === 2025-01-01 12:00:05
//   <content>
//   === USER ===
//   <content>
//   === ASSISTANT ===
//   <content>
//
// Compression strategy:
//   1. Parse segments by === delimiter
//   2. Extract <history> / <key_info> blocks from prompts
//   3. Deduplicate repeated blocks across turns
//   4. Truncate large tool results / code outputs
//   5. Write compressed version alongside original (.compressed suffix)

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  mkdirSync,
} from 'fs';
import { resolve, basename } from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionSegment {
  type: 'PROMPT' | 'RESPONSE' | 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL';
  timestamp?: string;
  content: string;
  compressedContent?: string;
}

export interface CompressResult {
  file: string;
  originalBytes: number;
  compressedBytes: number;
  ratio: number;
  segmentsProcessed: number;
}

export interface BatchResult {
  totalFiles: number;
  processedFiles: number;
  totalOriginalBytes: number;
  totalCompressedBytes: number;
  results: CompressResult[];
}

// ─── Segment parser ─────────────────────────────────────────────────────────

const SEGMENT_RE = /^=== (\w+) ===(?:\s*(.+))?$/;

/**
 * Parse a raw session log into structured segments.
 */
export function parseSegments(raw: string): SessionSegment[] {
  const lines = raw.split('\n');
  const segments: SessionSegment[] = [];
  let current: SessionSegment | null = null;

  for (const line of lines) {
    const match = line.match(SEGMENT_RE);
    if (match) {
      if (current) {
        current.content = current.content.trimEnd();
        segments.push(current);
      }
      const type = match[1].toUpperCase();
      const validTypes = ['PROMPT', 'RESPONSE', 'USER', 'ASSISTANT', 'SYSTEM', 'TOOL'];
      current = {
        type: validTypes.includes(type) ? (type as SessionSegment['type']) : 'SYSTEM',
        timestamp: match[2] || undefined,
        content: '',
      };
    } else if (current) {
      current.content += line + '\n';
    } else {
      // Content before first segment header – treat as preamble
      current = { type: 'SYSTEM', content: line + '\n' };
    }
  }

  if (current) {
    current.content = current.content.trimEnd();
    segments.push(current);
  }

  return segments;
}

// ─── History extraction ─────────────────────────────────────────────────────

/**
 * Extract `<history>` and `<key_info>` blocks from a text string.
 */
export function extractHistoryBlocks(text: string): { history: string[]; keyInfo: string[] } {
  const history: string[] = [];
  const keyInfo: string[] = [];

  const histRe = /<history>([\s\S]*?)<\/history>/gi;
  let match;
  while ((match = histRe.exec(text)) !== null) {
    const h = match[1].trim();
    if (h) history.push(h);
  }

  const kiRe = /<key_info>([\s\S]*?)<\/key_info>/gi;
  while ((match = kiRe.exec(text)) !== null) {
    const ki = match[1].trim();
    if (ki) keyInfo.push(ki);
  }

  return { history, keyInfo };
}

/**
 * Extract a condensed history from all segments in a session.
 * Deduplicates repeated entries and returns the summary.
 */
export function extractHistory(segments: SessionSegment[]): string {
  const seenLines = new Set<string>();
  const uniqueLines: string[] = [];

  for (const seg of segments) {
    const { history, keyInfo } = extractHistoryBlocks(seg.content);
    for (const h of history) {
      const lines = h.split('\n').map(l => l.trim()).filter(l => l);
      for (const line of lines) {
        if (!seenLines.has(line)) {
          seenLines.add(line);
          uniqueLines.push(line);
        }
      }
    }
    for (const ki of keyInfo) {
      if (!seenLines.has(ki)) {
        seenLines.add(ki);
        uniqueLines.push(ki);
      }
    }
  }

  // Keep at most 50 unique lines
  return uniqueLines.slice(-50).join('\n');
}

// ─── Content compression helpers ────────────────────────────────────────────

/**
 * Compress a single segment's content:
 * - Truncate very long lines (>2000 chars)
 * - Collapse repeated newlines
 * - Truncate if still too long
 */
function compressContent(content: string, maxLen: number = 4000): string {
  if (content.length <= maxLen) return content;

  // If it's a JSON blob (tool call response), try to summarize
  if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(content);
      const summary = summarizeJson(parsed);
      if (summary.length < content.length * 0.5) return summary;
    } catch { /* not valid JSON, fall through */ }
  }

  // Truncate long lines
  const lines = content.split('\n');
  const compressed = lines.map(line => {
    if (line.length > 2000) return line.slice(0, 2000) + '... [truncated]';
    return line;
  });

  let result = compressed.join('\n');

  // Collapse multiple blank lines
  result = result.replace(/\n{4,}/g, '\n\n\n');

  // Middle-truncate if still too long
  if (result.length > maxLen) {
    const half = Math.floor(maxLen / 2);
    result = result.slice(0, half) + '\n\n... [content truncated] ...\n\n' + result.slice(-half);
  }

  return result;
}

function summarizeJson(obj: unknown, depth: number = 0): string {
  if (depth > 2) return '...';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    if (obj.length <= 3) return JSON.stringify(obj.map(item => {
      if (typeof item === 'object' && item !== null) return summarizeJson(item, depth + 1);
      if (typeof item === 'string' && item.length > 100) return item.slice(0, 100) + '...';
      return item;
    }));
    return `[array of ${obj.length} items]`;
  }
  if (typeof obj === 'object' && obj !== null) {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length <= 5) {
      const summary: Record<string, unknown> = {};
      for (const [k, v] of entries) {
        if (typeof v === 'string' && v.length > 200) summary[k] = v.slice(0, 200) + '...';
        else if (typeof v === 'object' && v !== null) summary[k] = summarizeJson(v, depth + 1);
        else summary[k] = v;
      }
      return JSON.stringify(summary, null, 2);
    }
    return `{object with ${entries.length} keys}`;
  }
  return String(obj);
}

// ─── Session compressor ─────────────────────────────────────────────────────

/**
 * Compress a single session file.
 * Reads the file, parses segments, extracts and deduplicates history,
 * compresses large content blocks, and writes a .compressed file.
 */
export function compressSession(filePath: string): CompressResult | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const originalBytes = Buffer.byteLength(raw, 'utf-8');

    // Skip very small files
    if (originalBytes < 500) return null;

    const segments = parseSegments(raw);
    if (segments.length === 0) return null;

    // Compress each segment
    for (const seg of segments) {
      seg.compressedContent = compressContent(seg.content, 4000);
    }

    // Build compressed output
    const lines: string[] = [];
    // Write extracted history header
    const hist = extractHistory(segments);
    if (hist) {
      lines.push(`=== COMPRESSED_SESSION_HISTORY ===`);
      lines.push(hist);
      lines.push('=== END_HISTORY ===\n');
    }

    for (const seg of segments) {
      const header = `=== ${seg.type} ===${seg.timestamp ? ' ' + seg.timestamp : ''}`;
      lines.push(header);
      lines.push(seg.compressedContent || compressContent(seg.content));
      lines.push('');
    }

    const compressed = lines.join('\n');
    const compressedBytes = Buffer.byteLength(compressed, 'utf-8');

    const compressedPath = filePath.replace(/\.(json|txt)$/, '.compressed.$1');
    writeFileSync(compressedPath, compressed, 'utf-8');

    return {
      file: basename(filePath),
      originalBytes,
      compressedBytes,
      ratio: Math.round((compressedBytes / originalBytes) * 100),
      segmentsProcessed: segments.length,
    };
  } catch (err) {
    console.error(`[Compressor] Failed to compress ${filePath}: ${err}`);
    return null;
  }
}

// ─── Batch processor ────────────────────────────────────────────────────────

/**
 * Batch compress all session files in a directory.
 * Skipping files that already have a .compressed version if skipExisting is true.
 */
export function batchProcess(
  logDir: string,
  options: { maxFiles?: number; skipExisting?: boolean; minAgeHours?: number } = {},
): BatchResult {
  const maxFiles = options.maxFiles || 50;
  const skipExisting = options.skipExisting !== false;
  const minAgeHours = options.minAgeHours || 0;

  const result: BatchResult = {
    totalFiles: 0,
    processedFiles: 0,
    totalOriginalBytes: 0,
    totalCompressedBytes: 0,
    results: [],
  };

  try {
    mkdirSync(logDir, { recursive: true });
    const files = readdirSync(logDir)
      .filter(f => (f.endsWith('.json') || f.endsWith('.txt')) && !f.includes('.compressed.'))
      .map(f => ({
        name: f,
        path: resolve(logDir, f),
        mtime: statSync(resolve(logDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    result.totalFiles = files.length;

    for (const file of files) {
      if (result.processedFiles >= maxFiles) break;

      // Check min age
      if (minAgeHours > 0) {
        const ageHours = (Date.now() - file.mtime.getTime()) / (1000 * 3600);
        if (ageHours < minAgeHours) continue;
      }

      // Check if compressed version already exists
      if (skipExisting) {
        const compressedName = file.name.replace(/\.(json|txt)$/, '.compressed.$1');
        if (existsSync(resolve(logDir, compressedName))) continue;
      }

      const cr = compressSession(file.path);
      if (cr) {
        result.results.push(cr);
        result.totalOriginalBytes += cr.originalBytes;
        result.totalCompressedBytes += cr.compressedBytes;
        result.processedFiles++;
      }
    }

    // Log summary
    if (result.processedFiles > 0) {
      const overallRatio = result.totalOriginalBytes > 0
        ? Math.round((result.totalCompressedBytes / result.totalOriginalBytes) * 100)
        : 100;
      console.log(
        `[Compressor] Batch complete: ${result.processedFiles} files, ` +
        `${(result.totalOriginalBytes / 1024).toFixed(0)}KB → ` +
        `${(result.totalCompressedBytes / 1024).toFixed(0)}KB (${overallRatio}%)`,
      );
    }
  } catch (err) {
    console.error(`[Compressor] Batch error: ${err}`);
  }

  return result;
}

// ─── Scheduled compression ──────────────────────────────────────────────────

let _compressTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start automatic session compression on a schedule.
 * @param logDir Path to model_responses directory
 * @param intervalHours Run every N hours (default: 12)
 */
export function startAutoCompress(
  logDir: string,
  intervalHours: number = 12,
): void {
  if (_compressTimer) {
    clearInterval(_compressTimer);
  }

  const intervalMs = intervalHours * 3600 * 1000;

  // Run immediately on start
  batchProcess(logDir, { maxFiles: 100, minAgeHours: 1 });

  _compressTimer = setInterval(() => {
    console.log(`[Compressor] Running scheduled compression...`);
    batchProcess(logDir, { maxFiles: 100, minAgeHours: 1 });
  }, intervalMs);

  console.log(`[Compressor] Auto-compress started (every ${intervalHours}h)`);
}

/**
 * Stop automatic compression.
 */
export function stopAutoCompress(): void {
  if (_compressTimer) {
    clearInterval(_compressTimer);
    _compressTimer = null;
    console.log('[Compressor] Auto-compress stopped');
  }
}
