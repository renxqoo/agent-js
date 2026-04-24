import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  unlinkSync,
  renameSync,
  appendFileSync,
} from 'fs';
import { resolve, dirname, basename, extname, join, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { smartFormat } from './code-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptDir = resolve(__dirname, '..');

// ─── expandFileRefs ─────────────────────────────────────────────────────────

const FILE_REF_PATTERN = /\{\{file:([^:}]+?)(?::(\d+))?(?::(\d+))?\}\}/g;

/**
 * Expand {{file:path}} or {{file:path:startLine}} or {{file:path:startLine:endLine}}
 * references inside *text* with the content of the referenced files (line-numbered).
 *
 * Relative paths are resolved relative to cwd (defaults to process.cwd()).
 *
 * Returns the expanded text with references replaced.
 */
export function expandFileRefs(text: string, cwd?: string): string {
  const baseDir = cwd || process.cwd();

  return text.replace(FILE_REF_PATTERN, (match: string, filePath: string, startLine?: string, endLine?: string) => {
    const absPath = isAbsolute(filePath) ? filePath : resolve(baseDir, filePath);

    if (!existsSync(absPath)) {
      return `[File not found: ${filePath}]`;
    }

    try {
      const raw = readFileSync(absPath, 'utf-8');
      const lines = raw.split('\n');
      const start = startLine ? Math.max(1, parseInt(startLine, 10)) : 1;
      const end = endLine ? Math.min(lines.length, parseInt(endLine, 10)) : lines.length;

      // Build output with line numbers
      const selected = lines.slice(start - 1, end);
      const maxLineNum = String(end).length;
      const numbered = selected.map(
        (line, i) => String(start + i).padStart(maxLineNum, ' ') + ' | ' + line
      );

      return numbered.join('\n');
    } catch (e) {
      return `[Error reading file ${filePath}: ${e instanceof Error ? e.message : String(e)}]`;
    }
  });
}

// ─── filePatch ──────────────────────────────────────────────────────────────

/**
 * Patch a file: find *oldContent* (whitespace-normalized fuzzy match)
 * and replace the matching lines with *newContent*.
 *
 * The matching normalises both sides (strip trailing whitespace, collapse
 * internal whitespace) before comparing, so minor whitespace differences
 * are ignored.
 *
 * Returns { status, msg, path }.
 */
export function filePatch(
  filePath: string,
  oldContent: string,
  newContent: string
): { status: string; msg: string; path: string } {
  const absPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

  if (!existsSync(absPath)) {
    return { status: 'error', msg: `File not found: ${absPath}`, path: absPath };
  }

  try {
    const fileText = readFileSync(absPath, 'utf-8');

    // ── Normalize both sides for matching ─────────────────────────────────
    const normalize = (s: string) =>
      s
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((l) => l.trimEnd())
        .join('\n')
        .replace(/[^\S\n]+/g, ' ')
        .trim();

    const normalizedOld = normalize(oldContent);
    const normalizedFile = normalize(fileText);

    // Try to find the old content as a substring in the normalized file
    const matchIdx = normalizedFile.indexOf(normalizedOld);

    if (matchIdx === -1) {
      return {
        status: 'error',
        msg: `Could not find a unique match for the old content in ${basename(absPath)}.`,
        path: absPath,
      };
    }

    // Build the new file text by replacing the matched region
    // We need to map the normalized position back to real positions.
    // Strategy: work with individual lines for a cleaner patch.

    const oldLines = oldContent.replace(/\r\n/g, '\n').trimEnd().split('\n');
    const fileLines = fileText.replace(/\r\n/g, '\n').split('\n');

    // Find the line range where the old content lives
    const normOldLines = oldLines.map((l) => l.trimEnd().replace(/[^\S]+/g, ' '));
    let startLine = -1;
    let endLine = -1;

    for (let i = 0; i <= fileLines.length - normOldLines.length; i++) {
      const window = fileLines.slice(i, i + normOldLines.length);
      const normWindow = window.map((l) => l.trimEnd().replace(/[^\S]+/g, ' '));
      if (normWindow.every((nl, j) => nl === normOldLines[j])) {
        startLine = i;
        endLine = i + normOldLines.length;
        break;
      }
    }

    if (startLine === -1) {
      return {
        status: 'error',
        msg: `Could not find a unique line match for the old content in ${basename(absPath)}.`,
        path: absPath,
      };
    }

    // Preserve leading/trailing whitespace of the first/last matched lines
    const newLines = newContent.replace(/\r\n/g, '\n').trimEnd().split('\n');
    const leadingWs = (fileLines[startLine] || '').match(/^[^\S]*/)?.[0] || '';

    // Indent new lines to match the original indentation of the first matched line
    const indentedNewLines = newLines.map((l, j) => (j === 0 || l.trim() === '' ? l : l));

    const patchedLines = [
      ...fileLines.slice(0, startLine),
      ...indentedNewLines,
      ...fileLines.slice(endLine),
    ];

    writeFileSync(absPath, patchedLines.join('\n'), 'utf-8');

    return { status: 'success', msg: `Patched ${basename(absPath)}: replaced lines ${startLine + 1}-${endLine}.`, path: absPath };
  } catch (e) {
    return {
      status: 'error',
      msg: `Failed to patch ${basename(absPath)}: ${e instanceof Error ? e.message : String(e)}`,
      path: absPath,
    };
  }
}

// ─── fileRead ───────────────────────────────────────────────────────────────

export interface FileReadOptions {
  /** Keyword(s) to search for. Lines containing ANY keyword are returned. */
  keyword?: string | string[];
  /** Regex pattern to search for (applied per-line). */
  regex?: string;
  /** Fuzzy / approximate substring search query. */
  fuzzy?: string;
  /** If true, keyword/regex/fuzzy matching is case-insensitive. */
  ignoreCase?: boolean;
  /** Return at most this many lines. */
  limit?: number;
  /** Line range: [start, end] (1-based, inclusive). */
  lineRange?: [number, number];
  /** Maximum total characters in the output before truncation. */
  maxChars?: number;
}

/**
 * Read a file and return its content formatted with line numbers.
 *
 * Supports optional keyword search, regex search, fuzzy matching,
 * line-range slicing, and output truncation.
 *
 * Fuzzy matching finds lines that share a minimum fraction of
 * character trigrams with the query string.
 */
export function fileRead(
  filePath: string,
  options: FileReadOptions = {}
): { status: string; msg: string; path: string; content: string; lineCount: number } {
  const absPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

  if (!existsSync(absPath)) {
    return { status: 'error', msg: `File not found: ${absPath}`, path: absPath, content: '', lineCount: 0 };
  }

  // Check it is a file (not a directory)
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return { status: 'error', msg: `Cannot stat: ${absPath}`, path: absPath, content: '', lineCount: 0 };
  }

  if (stat.isDirectory()) {
    const children = readdirSync(absPath).join(', ');
    return {
      status: 'success',
      msg: `${basename(absPath)} is a directory.`,
      path: absPath,
      content: children ? `Directory contents:\n${children}` : '(empty directory)',
      lineCount: 0,
    };
  }

  try {
    const raw = readFileSync(absPath, 'utf-8');
    let lines = raw.split('\n');

    // ── Apply line-range filter ───────────────────────────────────────────
    if (options.lineRange) {
      const [start, end] = options.lineRange;
      const s = Math.max(1, start);
      const e = Math.min(lines.length, end);
      lines = lines.slice(s - 1, e);
    }

    // ── Apply keyword filter ──────────────────────────────────────────────
    if (options.keyword) {
      const keywords = Array.isArray(options.keyword) ? options.keyword : [options.keyword];
      const caseSensitive = !options.ignoreCase;
      lines = lines.filter((line) =>
        keywords.some((kw) => {
          if (caseSensitive) return line.includes(kw);
          return line.toLowerCase().includes(kw.toLowerCase());
        })
      );
    }

    // ── Apply regex filter ────────────────────────────────────────────────
    if (options.regex) {
      let flags = 'g';
      if (options.ignoreCase) flags += 'i';
      const re = new RegExp(options.regex, flags);
      lines = lines.filter((line) => re.test(line));
    }

    // ── Apply fuzzy filter ────────────────────────────────────────────────
    if (options.fuzzy && lines.length > 0) {
      const query = options.ignoreCase ? options.fuzzy.toLowerCase() : options.fuzzy;
      const threshold = 0.3; // minimum trigram overlap fraction

      const scored = lines.map((line, idx) => {
        const cmp = options.ignoreCase ? line.toLowerCase() : line;
        const score = trigramSimilarity(query, cmp);
        return { idx, line, score };
      });

      scored.sort((a, b) => b.score - a.score);
      lines = scored.filter((s) => s.score >= threshold).map((s) => s.line);
    }

    // ── Apply limit ───────────────────────────────────────────────────────
    if (options.limit && options.limit > 0) {
      lines = lines.slice(0, options.limit);
    }

    // ── Build numbered output ─────────────────────────────────────────────
    const maxLineNum = String(lines.length).length;
    let numberedLines = lines.map(
      (line, i) => String(i + 1).padStart(maxLineNum, ' ') + ' | ' + line
    );

    let output = numberedLines.join('\n');

    // ── Apply maxChars truncation ─────────────────────────────────────────
    const maxChars = options.maxChars || 10000;
    output = smartFormat(output, maxChars, '\n\n[omitted long output]\n\n');

    // ── Record access ─────────────────────────────────────────────────────
    logMemoryAccess('read', absPath, stat);

    return {
      status: 'success',
      msg: `Read ${basename(absPath)}`,
      path: absPath,
      content: output || '(no matching lines or empty file)',
      lineCount: lines.length,
    };
  } catch (e) {
    return {
      status: 'error',
      msg: `Failed to read ${basename(absPath)}: ${e instanceof Error ? e.message : String(e)}`,
      path: absPath,
      content: '',
      lineCount: 0,
    };
  }
}

// ─── trigramSimilarity ──────────────────────────────────────────────────────

/**
 * Compute a rough similarity score between *query* and *candidate*
 * using overlapping character trigrams (Dice-like).
 *
 * Returns a number in [0, 1].
 */
function trigramSimilarity(query: string, candidate: string): number {
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;

  const qTrigrams = extractTrigrams(query);
  const cTrigrams = new Set(extractTrigrams(candidate));

  if (qTrigrams.length === 0) return 0;

  let overlap = 0;
  for (const t of qTrigrams) {
    if (cTrigrams.has(t)) overlap++;
  }

  return overlap / qTrigrams.length;
}

function extractTrigrams(s: string): string[] {
  const trigrams: string[] = [];
  for (let i = 0; i < s.length - 2; i++) {
    trigrams.push(s.slice(i, i + 3));
  }
  return trigrams;
}

// ─── logMemoryAccess ────────────────────────────────────────────────────────

interface MemoryAccessEntry {
  path: string;
  action: string;
  size?: number;
  timestamp: number;
}

const _memoryLog: MemoryAccessEntry[] = [];
const MAX_MEMORY_LOG = 200;

/**
 * Log a file access event into the in-memory access log.
 *
 * Call this whenever a tool reads or writes a file so that the agent
 * can introspect recent file activity.
 */
export function logMemoryAccess(
  action: string,
  filePath: string,
  stats?: { size?: number }
): void {
  _memoryLog.push({
    path: filePath,
    action,
    size: stats?.size,
    timestamp: Date.now(),
  });

  // Keep the log bounded
  while (_memoryLog.length > MAX_MEMORY_LOG) {
    _memoryLog.shift();
  }
}

/**
 * Return the N most recent file access entries.
 */
export function getRecentAccesses(n: number = 50): MemoryAccessEntry[] {
  return _memoryLog.slice(-n);
}

/**
 * Return summary statistics on recent file accesses:
 *   - total files, distinct files, reads, writes, creates, deletes
 */
export function getMemoryAccessStats(): Record<string, unknown> {
  const recent = _memoryLog.slice(-100);
  const distinct = new Set(recent.map((e) => e.path));
  const reads = recent.filter((e) => e.action === 'read').length;
  const writes = recent.filter((e) => e.action === 'write').length;
  const creates = recent.filter((e) => e.action === 'create').length;
  const deletes = recent.filter((e) => e.action === 'delete').length;

  return {
    total_entries: _memoryLog.length,
    recent_entries: recent.length,
    distinct_files: distinct.size,
    reads,
    writes,
    creates,
    deletes,
    files: [...distinct].slice(-10),
  };
}

/**
 * Clear the in-memory access log.
 */
export function clearMemoryAccessLog(): void {
  _memoryLog.length = 0;
}

// ─── fileWrite / fileCreate / fileDelete ─────────────────────────────────────

/**
 * Write content to a file (creates directories if needed).
 * Also logs to the memory access log.
 */
export function fileWrite(
  filePath: string,
  content: string,
  mode: 'overwrite' | 'append' = 'overwrite'
): { status: string; msg: string; path: string } {
  const absPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const dir = dirname(absPath);

  try {
    mkdirSync(dir, { recursive: true });

    const existed = existsSync(absPath);

    if (mode === 'append') {
      appendFileSync(absPath, content, 'utf-8');
    } else {
      writeFileSync(absPath, content, 'utf-8');
    }

    const action = existed ? 'write' : 'create';
    logMemoryAccess(action, absPath, { size: Buffer.byteLength(content, 'utf-8') });

    return {
      status: 'success',
      msg: `${mode === 'append' ? 'Appended to' : 'Wrote'} ${basename(absPath)} (${content.length} chars)`,
      path: absPath,
    };
  } catch (e) {
    return {
      status: 'error',
      msg: `Failed to write ${basename(absPath)}: ${e instanceof Error ? e.message : String(e)}`,
      path: absPath,
    };
  }
}

/**
 * Ensure a file does NOT exist (delete if it does).
 */
export function fileDelete(
  filePath: string
): { status: string; msg: string; path: string } {
  const absPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

  try {
    if (existsSync(absPath)) {
      unlinkSync(absPath);
      logMemoryAccess('delete', absPath);
      return { status: 'success', msg: `Deleted ${basename(absPath)}`, path: absPath };
    }
    return { status: 'success', msg: `File does not exist: ${basename(absPath)}`, path: absPath };
  } catch (e) {
    return {
      status: 'error',
      msg: `Failed to delete ${basename(absPath)}: ${e instanceof Error ? e.message : String(e)}`,
      path: absPath,
    };
  }
}

/**
 * Move / rename a file.
 */
export function fileMove(
  srcPath: string,
  dstPath: string
): { status: string; msg: string; path: string } {
  const absSrc = isAbsolute(srcPath) ? srcPath : resolve(process.cwd(), srcPath);
  const absDst = isAbsolute(dstPath) ? dstPath : resolve(process.cwd(), dstPath);

  try {
    const dstDir = dirname(absDst);
    mkdirSync(dstDir, { recursive: true });

    renameSync(absSrc, absDst);
    logMemoryAccess('move', absDst);

    return {
      status: 'success',
      msg: `Moved ${basename(absSrc)} -> ${basename(absDst)}`,
      path: absDst,
    };
  } catch (e) {
    return {
      status: 'error',
      msg: `Failed to move ${basename(absSrc)}: ${e instanceof Error ? e.message : String(e)}`,
      path: absSrc,
    };
  }
}

/**
 * List files in a directory.
 */
export function fileList(
  dirPath: string,
  options: { extensions?: string[]; maxItems?: number } = {}
): { status: string; msg: string; path: string; entries: string[] } {
  const absPath = isAbsolute(dirPath) ? dirPath : resolve(process.cwd(), dirPath);

  try {
    if (!existsSync(absPath)) {
      return { status: 'error', msg: `Directory not found: ${dirPath}`, path: absPath, entries: [] };
    }

    const stat = statSync(absPath);
    if (!stat.isDirectory()) {
      return { status: 'error', msg: `Not a directory: ${dirPath}`, path: absPath, entries: [] };
    }

    let entries = readdirSync(absPath);

    if (options.extensions && options.extensions.length > 0) {
      const exts = new Set(options.extensions.map((e) => e.toLowerCase()));
      entries = entries.filter((name) => exts.has(extname(name).toLowerCase()));
    }

    if (options.maxItems && options.maxItems > 0) {
      entries = entries.slice(0, options.maxItems);
    }

    logMemoryAccess('list', absPath, stat);

    return {
      status: 'success',
      msg: `${entries.length} entries in ${basename(absPath)}`,
      path: absPath,
      entries,
    };
  } catch (e) {
    return {
      status: 'error',
      msg: `Failed to list ${basename(absPath)}: ${e instanceof Error ? e.message : String(e)}`,
      path: absPath,
      entries: [],
    };
  }
}

/**
 * Get the size of a file or directory (recursive approximation for dirs).
 */
export function fileSize(
  filePath: string
): { status: string; path: string; size: number } {
  const absPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

  try {
    if (!existsSync(absPath)) {
      return { status: 'error', path: absPath, size: 0 };
    }

    const stat = statSync(absPath);
    if (stat.isFile()) {
      return { status: 'success', path: absPath, size: stat.size };
    }

    // Rough recursive size for directories
    let total = 0;
    const walk = (dir: string) => {
      const entries = readdirSync(dir);
      for (const name of entries) {
        const p = join(dir, name);
        const s = statSync(p);
        if (s.isFile()) total += s.size;
        else if (s.isDirectory()) walk(p);
      }
    };
    walk(absPath);

    logMemoryAccess('stat', absPath, { size: total });
    return { status: 'success', path: absPath, size: total };
  } catch (e) {
    return { status: 'error', path: absPath, size: 0 };
  }
}

// ─── checkFileExists ────────────────────────────────────────────────────────

/**
 * Simple existence check. Returns boolean.
 */
export function fileExists(filePath: string): boolean {
  const absPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  return existsSync(absPath);
}
