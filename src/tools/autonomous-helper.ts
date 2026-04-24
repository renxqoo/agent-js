// tools/autonomous-helper.ts
// Autonomous-mode task management.
// Provides getTodo / getHistory / setTodo / completeTask to let the agent
// self-manage a task queue and write structured completion reports.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptDir = resolve(__dirname, '..', '..');

const TODO_PATH = resolve(scriptDir, 'temp/TODO.txt');
const REPORTS_DIR = resolve(scriptDir, 'temp/autonomous_reports');
const HISTORY_LOG = resolve(scriptDir, 'temp/autonomous_history.log');

// ─── Ensure directories exist ───────────────────────────────────────────────

function ensureDir(): void {
  mkdirSync(dirname(TODO_PATH), { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });
}

// ─── Todo item ──────────────────────────────────────────────────────────────

export interface TodoItem {
  task: string;
  status: 'pending' | 'in_progress' | 'done';
  createdAt: string;
  completedAt?: string;
}

// ─── Autonomous report ──────────────────────────────────────────────────────

export interface AutonomousReport {
  task: string;
  result: string;
  timestamp: string;
  durationMs: number;
  toolCalls: number;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse the current TODO.txt into structured items.
 * Format (one per line):
 *   [ ] task description        → pending
 *   [-] task description        → in_progress (not started)
 *   [x] task description        → done
 *   plain text                  → pending (auto-bracketed)
 */
export function getTodo(): TodoItem[] {
  ensureDir();
  const items: TodoItem[] = [];

  if (!existsSync(TODO_PATH)) return items;

  try {
    const raw = readFileSync(TODO_PATH, 'utf-8');
    const lines = raw.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let status: TodoItem['status'] = 'pending';
      let task = trimmed;

      const doneMatch = trimmed.match(/^\[x\]\s+(.+)/i);
      const progMatch = trimmed.match(/^\[-\]\s+(.+)/i);
      const pendMatch = trimmed.match(/^\[\s+\]\s+(.+)/i);

      if (doneMatch) {
        status = 'done';
        task = doneMatch[1];
      } else if (progMatch) {
        status = 'in_progress';
        task = progMatch[1];
      } else if (pendMatch) {
        status = 'pending';
        task = pendMatch[1];
      }

      items.push({
        task,
        status,
        createdAt: '',
        completedAt: status === 'done' ? '' : undefined,
      });
    }
  } catch {
    // Return empty list on read error
  }

  return items;
}

/**
 * Get recent autonomous task history from the history log.
 * @param n Max number of entries to return (most recent first).
 */
export function getHistory(n: number = 20): string[] {
  if (!existsSync(HISTORY_LOG)) return [];

  try {
    const raw = readFileSync(HISTORY_LOG, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    return lines.slice(-n).reverse();
  } catch {
    return [];
  }
}

/**
 * Set (overwrite) the TODO list with new items.
 * Converts an array of strings or TodoItem objects.
 */
export function setTodo(items: (string | TodoItem)[]): void {
  ensureDir();

  const lines = items.map(item => {
    if (typeof item === 'string') {
      return `[ ] ${item}`;
    }
    const marker = item.status === 'done' ? '[x]'
      : item.status === 'in_progress' ? '[-]'
      : '[ ]';
    return `${marker} ${item.task}`;
  });

  writeFileSync(TODO_PATH, lines.join('\n') + '\n', 'utf-8');
}

/**
 * Mark a task as complete. Writes a structured report to autonomous_reports/
 * and appends a history entry to the log.
 */
export function completeTask(
  task: string,
  result: string,
  durationMs: number = 0,
  toolCalls: number = 0,
): void {
  ensureDir();

  // Write structured report
  const ts = new Date();
  const isoStr = ts.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const report: AutonomousReport = {
    task,
    result,
    timestamp: ts.toISOString(),
    durationMs,
    toolCalls,
  };

  const reportFile = resolve(REPORTS_DIR, `report_${isoStr}.json`);
  writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');

  // Append history entry
  const logLine = `[${ts.toISOString()}] DONE: ${task.slice(0, 120)} (${durationMs}ms, ${toolCalls} tool calls)`;
  appendFileSync(HISTORY_LOG, logLine + '\n', 'utf-8');

  // Update TODO – mark the matching task as done
  if (existsSync(TODO_PATH)) {
    const items = getTodo();
    let found = false;
    for (const item of items) {
      if (item.task === task || item.task.includes(task.slice(0, 30))) {
        item.status = 'done';
        item.completedAt = ts.toISOString();
        found = true;
        break;
      }
    }
    // If exact match not found, add as completed
    if (!found) {
      items.push({
        task,
        status: 'done',
        createdAt: ts.toISOString(),
        completedAt: ts.toISOString(),
      });
    }
    setTodo(items);
  }
}

/**
 * Get pending task count.
 */
export function pendingCount(): number {
  return getTodo().filter(t => t.status !== 'done').length;
}

/**
 * Get the next pending task, or null if all are done.
 * Marks it as in_progress automatically.
 */
export function nextTask(): TodoItem | null {
  const items = getTodo();
  const next = items.find(t => t.status === 'pending');
  if (next) {
    next.status = 'in_progress';
    setTodo(items);
  }
  return next || null;
}
