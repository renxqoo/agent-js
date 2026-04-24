// frontends/chatapp-common.ts
// Chat utilities and commands shared across all frontends.
// Ported from Python's chatapp_common.py.

/**
 * Supported chat commands and their descriptions.
 */
export const CHAT_COMMANDS: Record<string, string> = {
  '/help': 'Show this help',
  '/stop': 'Abort current task',
  '/status': 'Show agent status',
  '/llm': 'List available LLMs',
  '/restore': 'Restore previous session',
  '/continue': 'Continue previous task',
};

/**
 * Format a chat message with source prefix for display.
 */
export function formatChatMessage(text: string, source: string = 'assistant'): string {
  const prefix = getSourcePrefix(source);
  return `${prefix} ${text}`;
}

/**
 * Get a display prefix for a message source.
 */
function getSourcePrefix(source: string): string {
  switch (source.toLowerCase()) {
    case 'user':
      return '[USER]';
    case 'assistant':
      return '[AGENT]';
    case 'system':
      return '[SYS]';
    case 'tool':
      return '[TOOL]';
    case 'error':
      return '[ERR]';
    default:
      return `[${source.toUpperCase()}]`;
  }
}

/**
 * Extract a command from a message string.
 * Returns [command, rest] or [null, message] if no command found.
 */
export function parseCommand(message: string): [string | null, string] {
  const trimmed = message.trimStart();
  if (!trimmed.startsWith('/')) {
    return [null, message];
  }

  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return [trimmed, ''];
  }

  return [trimmed.slice(0, spaceIdx), trimmed.slice(spaceIdx + 1).trim()];
}

/**
 * Check if a message starts with a known chat command.
 */
export function isChatCommand(message: string): boolean {
  const trimmed = message.trimStart();
  if (!trimmed.startsWith('/')) return false;

  const spaceIdx = trimmed.indexOf(' ');
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);

  return cmd in CHAT_COMMANDS;
}

/**
 * Format the help text for all chat commands.
 */
export function formatHelpText(): string {
  const lines = ['Available commands:'];
  for (const [cmd, desc] of Object.entries(CHAT_COMMANDS)) {
    lines.push(`  ${cmd.padEnd(12)} - ${desc}`);
  }
  return lines.join('\n');
}

/**
 * Format a status display string.
 */
export function formatStatusDisplay(status: Record<string, unknown>): string {
  const lines = ['[AGENT STATUS]'];
  for (const [key, value] of Object.entries(status)) {
    lines.push(`  ${key}: ${value}`);
  }
  return lines.join('\n');
}

/**
 * Format a multi-line block for display in terminal/chat.
 */
export function formatBlock(text: string, header?: string): string {
  const sep = '─'.repeat(60);
  const parts: string[] = [];

  if (header) {
    parts.push(`${sep}\n  ${header}\n${sep}`);
  } else {
    parts.push(sep);
  }

  parts.push(text);
  parts.push(sep);

  return parts.join('\n');
}

// ─── Session Preview formatting ─────────────────────────────────────────────

export interface SessionPreviewEntry {
  path: string;
  mtime: Date;
  relativeTime: string;
  roundCount: number;
  firstUserText: string;
  modelName: string;
  summary: string;
}

/**
 * Format a list of session previews for display.
 */
export function formatSessionPreviews(sessions: SessionPreviewEntry[], maxDisplay: number = 10): string {
  if (!sessions.length) return 'No previous sessions found.';

  const lines: string[] = ['[RECENT SESSIONS]'];
  for (let i = 0; i < Math.min(sessions.length, maxDisplay); i++) {
    const s = sessions[i];
    const time = s.relativeTime || s.mtime.toISOString().slice(0, 19);
    const rounds = s.roundCount ? `${s.roundCount} turns` : '? turns';
    const text = s.firstUserText ? s.firstUserText.slice(0, 60) : '(no query)';
    const model = s.modelName ? ` [${s.modelName}]` : '';
    lines.push(`  ${i + 1}. ${time} | ${rounds}${model} | ${text}`);
  }
  return lines.join('\n');
}

/**
 * Format a single session preview.
 */
export function formatSessionPreview(session: SessionPreviewEntry): string {
  const lines: string[] = [
    `Session: ${session.path}`,
    `  Time:     ${session.relativeTime}`,
    `  Rounds:   ${session.roundCount || '?'}`,
    `  Model:    ${session.modelName || 'unknown'}`,
    `  Query:    ${session.firstUserText || '(none)'}`,
    `  Summary:  ${session.summary.slice(0, 200)}`,
  ];
  return lines.join('\n');
}

// ─── ChatAppBase ────────────────────────────────────────────────────────────

export interface ChatAppOptions {
  /** Working directory for lock files and temp data. */
  workDir?: string;
  /** Heartbeat interval in ms (default: 30000). */
  heartbeatInterval?: number;
  /** Idle timeout in ms before triggering onIdle (default: 300000 = 5min). */
  idleTimeout?: number;
  /** Maximum concurrent async tasks. */
  maxConcurrentTasks?: number;
}

/**
 * Abstract base class for chat frontends.
 *
 * Provides:
 * - Async task runner with concurrency limiting
 * - Heartbeat keep-alive timer
 * - Single-instance lock (prevents duplicate process starts)
 * - Idle detection with callback
 */
export abstract class ChatAppBase {
  protected workDir: string;
  protected heartbeatInterval: number;
  protected idleTimeout: number;
  protected maxConcurrentTasks: number;

  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastActivity: number = Date.now();
  private _lockFd: number | null = null;
  private _activeTasks: Set<Promise<unknown>> = new Set();
  private _isRunning: boolean = false;

  constructor(options: ChatAppOptions = {}) {
    this.workDir = options.workDir || 'temp';
    this.heartbeatInterval = options.heartbeatInterval || 30000;
    this.idleTimeout = options.idleTimeout || 300000;
    this.maxConcurrentTasks = options.maxConcurrentTasks || 5;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Start the chat app: acquire lock, start heartbeat, begin idle detection. */
  async start(): Promise<void> {
    if (this._isRunning) return;
    this._isRunning = true;

    await this.acquireLock();
    this.startHeartbeat();
    this.resetIdleTimer();
    await this.onStart();
  }

  /** Stop the chat app: release lock, clear timers, cleanup. */
  async stop(): Promise<void> {
    if (!this._isRunning) return;
    this._isRunning = false;

    this.stopHeartbeat();
    this.clearIdleTimer();
    await this.releaseLock();
    await this.onStop();
  }

  // ── Abstract hooks ──────────────────────────────────────────────────────

  /** Called after start-up completes (lock acquired, heartbeat started). */
  protected abstract onStart(): Promise<void>;

  /** Called during shutdown. */
  protected abstract onStop(): Promise<void>;

  /** Called when the app has been idle for longer than `idleTimeout`. */
  protected abstract onIdle(): Promise<void>;

  // ── Single-instance lock ─────────────────────────────────────────────────

  private async acquireLock(): Promise<void> {
    try {
      const { existsSync, writeFileSync, unlinkSync } = await import('fs');
      const { resolve } = await import('path');
      const lockFile = resolve(this.workDir, '.ga_chatapp.lock');

      if (existsSync(lockFile)) {
        console.warn('[ChatApp] Another instance may be running. Lock file exists.');
        // Read PID and check if still alive
        try {
          const pid = parseInt((await import('fs')).readFileSync(lockFile, 'utf-8').trim());
          try { process.kill(pid, 0); } catch {
            // Process not alive; stale lock
            unlinkSync(lockFile);
          }
        } catch { /* ignore */ }
      }

      writeFileSync(lockFile, String(process.pid), 'utf-8');
      this._lockFd = 1; // signal that we own the lock
    } catch (err) {
      console.warn(`[ChatApp] Lock acquisition warning: ${err}`);
    }
  }

  private async releaseLock(): Promise<void> {
    if (this._lockFd === null) return;
    try {
      const { existsSync, unlinkSync } = await import('fs');
      const { resolve } = await import('path');
      const lockFile = resolve(this.workDir, '.ga_chatapp.lock');
      if (existsSync(lockFile)) unlinkSync(lockFile);
    } catch { /* best-effort */ }
    this._lockFd = null;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this.onHeartbeat();
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /** Called on each heartbeat tick. Override to add custom logic. */
  protected onHeartbeat(): void {
    // Default: update activity timestamp to prevent false idle triggers
    this._lastActivity = Date.now();
  }

  // ── Idle detection ────────────────────────────────────────────────────────

  /** Mark activity to reset the idle timer. Call this on user input. */
  markActivity(): void {
    this._lastActivity = Date.now();
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this._idleTimer = setTimeout(() => {
      const idleMs = Date.now() - this._lastActivity;
      if (idleMs >= this.idleTimeout) {
        this.onIdle().catch(err => console.error('[ChatApp] onIdle error:', err));
      }
    }, this.idleTimeout);
  }

  private clearIdleTimer(): void {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /** Get idle duration in milliseconds. */
  get idleDuration(): number {
    return Date.now() - this._lastActivity;
  }

  /** Whether the app is currently considered idle. */
  get isIdle(): boolean {
    return this.idleDuration >= this.idleTimeout;
  }

  // ── Async task runner ─────────────────────────────────────────────────────

  /** Number of currently running tasks. */
  get activeTaskCount(): number {
    return this._activeTasks.size;
  }

  /**
   * Run an async task with concurrency limiting.
   * If at capacity, waits for a slot to free up.
   * Returns the task's result (or throws its error).
   */
  async runTask<T>(task: () => Promise<T>, name?: string): Promise<T> {
    // Wait if at capacity
    while (this._activeTasks.size >= this.maxConcurrentTasks) {
      await Promise.race(this._activeTasks);
    }

    const promise = task()
      .catch(err => {
        console.error(`[ChatApp] Task${name ? ` "${name}"` : ''} failed:`, err);
        throw err;
      })
      .finally(() => {
        this._activeTasks.delete(promise);
      });

    this._activeTasks.add(promise);
    return promise;
  }

  /**
   * Schedule a task to run asynchronously without waiting for the result.
   * Errors are logged but do not propagate.
   */
  scheduleTask(task: () => Promise<void>, name?: string): void {
    this.runTask(task, name).catch(() => { /* errors already logged */ });
  }

  /** Wait for all active tasks to complete. */
  async waitForTasks(): Promise<void> {
    while (this._activeTasks.size > 0) {
      await Promise.race([...this._activeTasks, Promise.resolve()]);
    }
  }
}
