import { EventEmitter } from 'events';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { resolve, join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import {
  LLMSession, ClaudeSession, MixinSession,
  ToolClient, NativeToolClient,
  NativeClaudeSession, NativeOAISession,
  getMyKeys, writeLLMLog
} from './core/llm-core.js';
import type {
  SessionConfig, MixinConfig, MyKeys,
  Message, ToolSchema, DisplayItem
} from './core/types.js';
import { agentRunnerLoop } from './core/agent-loop.js';
import { GenericAgentHandler, consumeFile } from './core/handler.js';
import { listRecentSessions } from './frontends/continue-cmd.js';
import { smartFormat } from './tools/code-runner.js';
import { startAgentTaskTrace, endAgentTaskTrace } from './plugins/langfuse-tracing.js';
// Re-export smartFormat for convenience
export { smartFormat };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = resolve(__dirname, '..');

// ─── Task Queue Entry ───────────────────────────────────────────────────────

interface TaskEntry {
  query: string;
  source: string;
  images: string[];
  display: TaskDisplay;
}

/**
 * TaskDisplay provides a mechanism for the caller to receive output
 * chunks from the agent's processing. This replaces Python's queue.Queue.
 */
export class TaskDisplay extends EventEmitter {
  private _done: boolean = false;

  /**
   * Push a display item from the agent loop.
   */
  push(item: DisplayItem): void {
    this.emit('item', item);
  }

  /**
   * Mark the task as done.
   */
  done(finalMessage?: string): void {
    if (this._done) return;
    this._done = true;
    this.emit('done', finalMessage || '');
  }

  /**
   * Report an error.
   */
  error(err: Error | string): void {
    this.emit('error', err instanceof Error ? err : new Error(err));
  }

  get isDone(): boolean {
    return this._done;
  }

  /**
   * Create a promise that resolves when the task is complete.
   */
  waitForDone(): Promise<string> {
    return new Promise((resolve, _reject) => {
      if (this._done) {
        resolve('');
        return;
      }
      this.once('done', resolve);
      this.once('error', (err: Error) => {
        // Resolve instead of reject to prevent unhandled promise rejections
        // The caller should still handle errors via the 'error' event
        resolve(err instanceof Error ? err.message : String(err));
      });
    });
  }
}

// ─── Session Types ──────────────────────────────────────────────────────────

type LLMClient = {
  backend: NativeClaudeSession | NativeOAISession | LLMSession | ClaudeSession | MixinSession;
  client: NativeToolClient | ToolClient;
  name: string;
  isNative: boolean;
};

// ─── Agent Abort Signal ─────────────────────────────────────────────────────

export class AbortSignal_ {
  private _aborted: boolean = false;

  abort(): void {
    this._aborted = true;
  }

  reset(): void {
    this._aborted = false;
  }

  get aborted(): boolean {
    return this._aborted;
  }
}

// ─── GeneraticAgent ─────────────────────────────────────────────────────────

export class GeneraticAgent extends EventEmitter {
  // Configuration
  private mykeys: MyKeys;
  private llmclients: LLMClient[];

  // Task queue
  private taskQueue: TaskEntry[] = [];
  private running: boolean = false;
  private _currentDisplay: TaskDisplay | null = null;

  // Abort control
  abortSignal: AbortSignal_ = new AbortSignal_();

  // History
  history: string[] = [];

  // Handler reference (for cross-task key_info carry-forward, same as Python)
  handler: any = null;

  // Temporary directory
  tempDir: string;

  // Global state (shared across sessions)
  globalState: Record<string, unknown> = {};

  // Slash command handlers
  private slashCmdHandlers: Record<string, (args: string, display: TaskDisplay) => boolean> = {};

  constructor() {
    super();

    // ─── Create temp directory ──────────────────────────────────────────────
    this.tempDir = join(SCRIPT_DIR, 'temp');
    if (!existsSync(this.tempDir)) {
      mkdirSync(this.tempDir, { recursive: true });
    }

    // ─── Load configuration ────────────────────────────────────────────────
    this.mykeys = getMyKeys();

    // ─── Build LLM client list ─────────────────────────────────────────────
    this.llmclients = this._buildLLMClients();

    // ─── Log initialization ────────────────────────────────────────────────
    console.log(`[GeneraticAgent] Initialized with ${this.llmclients.length} LLM client(s).`);
  }

  /**
   * Build the LLM client list from mykeys configuration.
   * Filters keys matching 'api', 'config', or 'cookie' patterns.
   * Groups consecutive matching keys into MixinSessions.
   */
  private _buildLLMClients(): LLMClient[] {
    const clients: LLMClient[] = [];

    // Determine which keys are session configs (having 'apikey' or 'apibase')
    const isSessionConfig = (val: unknown): val is SessionConfig => {
      if (typeof val !== 'object' || val === null) return false;
      const obj = val as Record<string, unknown>;
      return ('apikey' in obj || 'apibase' in obj) && typeof obj.model === 'string';
    };

    // Filter keys that contain one of the trigger patterns
    const triggerKeys = Object.keys(this.mykeys).filter(key => {
      const lower = key.toLowerCase();
      return lower.includes('api') || lower.includes('config') || lower.includes('cookie');
    });

    if (triggerKeys.length === 0) {
      console.log('[GeneraticAgent] No matching session keys found in mykeys. Trigger patterns: api, config, cookie');
      return clients;
    }

    // Group consecutive trigger keys into mixin groups
    const groups: string[][] = [];
    let currentGroup: string[] = [];

    for (let i = 0; i < triggerKeys.length; i++) {
      currentGroup.push(triggerKeys[i]);

      // Check if next key has a different prefix type (api vs config vs cookie)
      // If so, start a new group
      const currentPrefix = triggerKeys[i].replace(/[0-9]+$/g, '');
      const nextKey = triggerKeys[i + 1];
      if (!nextKey) {
        groups.push(currentGroup);
        break;
      }
      const nextPrefix = nextKey.replace(/[0-9]+$/g, '');

      if (currentPrefix !== nextPrefix) {
        groups.push(currentGroup);
        currentGroup = [];
      }
    }

    // For each group, create sessions
    for (const group of groups) {
      if (group.length === 1) {
        // Single key: create a single session
        const key = group[0];
        const cfg = this.mykeys[key];
        if (!isSessionConfig(cfg)) continue;
        clients.push(this._createSingleClient(cfg));
      } else {
        // Multiple keys: create a MixinSession
        const mixinClients = this._createMixinClients(group);
        if (mixinClients) {
          clients.push(mixinClients);
        }
      }
    }

    return clients;
  }

  /**
   * Create a single (non-mixin) LLM client from a session config.
   */
  private _createSingleClient(cfg: SessionConfig): LLMClient {
    const isNative = this._isNativeSession(cfg);

    if (isNative) {
      const backend = new NativeClaudeSession(cfg);
      const client = new NativeToolClient(backend);
      return { backend, client, name: backend.name, isNative: true };
    } else {
      // Detect Claude vs OpenAI-compatible
      const base = cfg.apibase || '';
      const model = cfg.model || '';
      // Anthropic native (api.anthropic.com) OR Anthropic-compatible proxy (/anthropic path)
      const isClaudeAPI = base.includes('api.anthropic.com')
        || /\/anthropic(\/|$)/i.test(base)
        || model.toLowerCase().startsWith('claude');

      const backend = isClaudeAPI ? new ClaudeSession(cfg) : new LLMSession(cfg);
      const client = new ToolClient(backend);
      return { backend, client, name: backend.name, isNative: false };
    }
  }

  /**
   * Create a MixinSession from a group of keys.
   */
  private _createMixinClients(keys: string[]): LLMClient | null {
    const allSessions: ({ backend: LLMClient['backend'] } | ToolClient | NativeToolClient)[] = [];

    // First, build individual sessions for each key in the group
    const tempClients: LLMClient[] = [];
    for (const key of keys) {
      const cfg = this.mykeys[key];
      if (typeof cfg !== 'object' || cfg === null) continue;

      const isSession = 'apikey' in cfg && 'model' in cfg;
      if (!isSession) continue;

      const client = this._createSingleClient(cfg as SessionConfig);
      tempClients.push(client);
    }

    if (tempClients.length === 0) return null;

    // Check all or none are native
    const allNative = tempClients.every(c => c.isNative);
    const anyNative = tempClients.some(c => c.isNative);
    if (anyNative && !allNative) {
      console.log('[GeneraticAgent] WARN: Mixing native and non-native sessions in a group, skipping mixin.');
      return null;
    }

    // Push all sessions into allSessions array
    for (const tc of tempClients) {
      allSessions.push({ backend: tc.backend });
    }

    // Determine the mixin config
    const mixinCfgKey = keys.find(k => {
      const v = this.mykeys[k];
      return typeof v === 'object' && v !== null && ('apikey' in v) && ('model' in v);
    });

    const mixinCfg: MixinConfig = {
      max_retries: 3,
      base_delay: 1.5,
      spring_back: 300,
      llm_nos: tempClients.map((_, i) => i),
    };

    // Check if there's a dedicated mixin config key
    for (const key of keys) {
      const v = this.mykeys[key];
      if (typeof v === 'object' && v !== null && 'llm_nos' in v) {
        Object.assign(mixinCfg, v);
        break;
      }
    }

    const mixin = new MixinSession(allSessions, mixinCfg);

    // Create the appropriate client wrapper
    const primary = mixin.sessions[0];
    const isNative = primary instanceof NativeClaudeSession || primary instanceof NativeOAISession;

    const client = isNative
      ? new NativeToolClient(primary as NativeClaudeSession)
      : new ToolClient(primary as LLMSession);

    return { backend: mixin, client, name: mixin.name, isNative };
  }

  /**
   * Determine if a session config represents a native session.
   */
  private _isNativeSession(cfg: SessionConfig): boolean {
    // Check for native-specific fields
    if (cfg.user_agent) return true;
    if (cfg.fake_cc_system_prompt) return true;
    // Check api_mode for 'native' or 'messages'
    const apiMode = String(cfg.api_mode || '').toLowerCase();
    return apiMode === 'native' || apiMode === 'messages';
  }

  // ─── LLM Selection ────────────────────────────────────────────────────────

  /**
   * Get the next available LLM client.
   * @param n Index or identifier. -1 returns the default (first client).
   *           A number returns that specific index (wrapped).
   *           A string searches by name.
   */
  nextLLM(n: number | string = -1): LLMClient | null {
    if (this.llmclients.length === 0) return null;

    if (typeof n === 'string') {
      // Search by name
      const nameLower = n.toLowerCase();
      const found = this.llmclients.find(c => c.name.toLowerCase() === nameLower);
      if (found) return found;
      // Try partial match
      return this.llmclients.find(c => c.name.toLowerCase().includes(nameLower)) || this.llmclients[0];
    }

    if (n < 0) return this.llmclients[0];
    return this.llmclients[n % this.llmclients.length] || this.llmclients[0];
  }

  /**
   * List all available LLM clients.
   */
  listLLMs(): string[] {
    return this.llmclients.map(c => c.name);
  }

  /**
   * Get the name of the default LLM client.
   * @param b Optional: if string, use as key to find specific; if number, use as index.
   * @param model If true, return model name instead of session name.
   */
  getLLMName(b?: string | number | null, model?: boolean): string {
    if (b === null && !model) {
      const c = this.nextLLM();
      return c ? c.name : '';
    }

    if (typeof b === 'number') {
      const c = this.nextLLM(b);
      if (!c) return '';
      return model ? (c.backend as unknown as Record<string, string>).model || c.name : c.name;
    }

    if (typeof b === 'string') {
      const c = this.nextLLM(b);
      if (!c) return '';
      return model ? (c.backend as unknown as Record<string, string>).model || c.name : c.name;
    }

    const c = this.nextLLM(-1);
    if (!c) return '';
    return model ? (c.backend as unknown as Record<string, string>).model || c.name : c.name;
  }

  // ─── Abort ────────────────────────────────────────────────────────────────

  /**
   * Abort the current running task.
   */
  abort(): void {
    this.abortSignal.abort();
    if (this._currentDisplay) {
      this._currentDisplay.push({ done: 'Task aborted by user.' });
      this._currentDisplay.done('aborted');
    }
    this.emit('abort');
  }

  // ─── Task Queue ───────────────────────────────────────────────────────────

  /**
   * Put a task into the processing queue.
   * Returns a TaskDisplay object that the caller can listen to for output.
   *
   * @param query The user query / task description.
   * @param source Source of the task (default: "user").
   * @param images Optional array of image data (base64 strings).
   * @returns TaskDisplay for receiving output chunks.
   */
  putTask(query: string, source: string = 'user', images: string[] = []): TaskDisplay {
    const display = new TaskDisplay();

    // Handle slash commands before queueing
    if (this._handleSlashCmd(query, display)) {
      return display;
    }

    this.taskQueue.push({ query, source, images, display });

    // If the agent isn't running yet, kick-start it
    if (!this.running) {
      this.running = true;
      // Defer to next tick to allow caller to attach listeners
      setImmediate(() => {
        this._processTaskLoop().catch(err => {
          console.error('[GeneraticAgent] Error in task loop:', err);
          this.running = false;
        });
      });
    }

    return display;
  }

  /**
   * Handle slash commands (e.g., /session, /resume).
   * Returns true if the query was handled as a slash command.
   */
  private _handleSlashCmd(rawQuery: string, display: TaskDisplay): boolean {
    const trimmed = rawQuery.trim();

    if (trimmed === '/llms') {
      const names = this.listLLMs();
      display.push({ done: names.join('\n') });
      display.done();
      return true;
    }

    if (trimmed.startsWith('/session')) {
      const match = trimmed.match(/^\/session[\s=:]+(.+?)$/);
      if (match) {
        const target = match[1].trim();
        const llm = this.nextLLM(target);
        if (llm) {
          display.push({ done: `Switched to session: ${llm.name}` });
        } else {
          display.push({ done: `Session not found: ${target}` });
        }
        display.done();
        return true;
      }

      // /session without = shows current
      const current = this.nextLLM(-1);
      display.push({ done: current ? `Current session: ${current.name}` : 'No active sessions' });
      display.done();
      return true;
    }

    if (trimmed.startsWith('/resume')) {
      const match = trimmed.match(/^\/resume\s+(.+)$/);
      if (match) {
        const filePath = match[1].trim();
        const fullPath = resolve(process.cwd(), filePath);
        if (existsSync(fullPath)) {
          try {
            const content = consumeFile(dirname(fullPath), basename(fullPath));
            if (content !== undefined) {
              display.push({ done: `Resume loaded from ${filePath}` });
              // Queue the content as a new task
              const resumeDisplay = new TaskDisplay();
              this.taskQueue.push({ query: content, source: 'resume', images: [], display: resumeDisplay });
              // Pipe the resume display events to the caller's display
              resumeDisplay.on('item', (item: DisplayItem) => display.push(item));
              resumeDisplay.on('done', (msg: string) => {
                display.push({ done: msg ? `Resume complete: ${msg}` : 'Resume complete.' });
                display.done();
              });
              resumeDisplay.on('error', (err: Error) => display.error(err));
              // Kick-start processing if needed
              if (this.running) {
                setImmediate(() => {
                  this._processTaskLoop().catch(e => {
                  console.error('[GeneraticAgent] Error in resume task loop:', e);
                });
              });
            }
            }
          } catch (e) {
            display.push({ done: `Failed to load resume file: ${e}` });
            display.done();
          }
        } else {
          display.push({ done: `File not found: ${filePath}` });
          display.done();
        }
        return true;
      }
    }

    // Check registered slash commands
    for (const [cmdPrefix, handler] of Object.entries(this.slashCmdHandlers)) {
      if (trimmed.startsWith(cmdPrefix)) {
        const args = trimmed.slice(cmdPrefix.length).trim();
        if (handler(args, display)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Register a custom slash command handler.
   * @param prefix The command prefix (e.g., "/mycmd")
   * @param handler Function that receives args string and display, returns true if handled.
   */
  registerSlashCommand(prefix: string, handler: (args: string, display: TaskDisplay) => boolean): void {
    this.slashCmdHandlers[prefix] = handler;
  }

  // ─── Main Run Loop ────────────────────────────────────────────────────────

  /**
   * Start the agent's main processing loop.
   * This runs asynchronously and processes tasks from the task queue.
   * In Python, this was `threading.Thread(target=agent.run, daemon=True).start()`.
   * In TypeScript, call `agent.run()` to start. It resolves when the queue is empty.
   */
  async run(): Promise<void> {
    this.running = true;
    try {
      await this._processTaskLoop();
    } finally {
      // Only stop if no pending tasks (putTask may have queued a task
      // between _processTaskLoop returning and this finally block)
      if (this.taskQueue.length === 0) {
        this.running = false;
      }
    }
  }

  /**
   * Internal task processing loop.
   * Consumes tasks from the queue sequentially.
   */
  private async _processTaskLoop(): Promise<void> {
    while (this.running && this.taskQueue.length > 0) {
      const task = this.taskQueue.shift();
      if (!task) break;

      this._currentDisplay = task.display;
      this.abortSignal.reset();

      try {
        await this._executeTask(task);
      } catch (err) {
        console.error('[GeneraticAgent] Task execution error:', err);
        task.display.error(err instanceof Error ? err : new Error(String(err)));
      }

      this._currentDisplay = null;
    }

    // If no more tasks, stop running
    if (this.taskQueue.length === 0) {
      this.running = false;
    }
  }

  /**
   * Load history from the most recent prior session.
   * Scans temp/model_responses/ for log files, excluding the
   * current process's own log. Extracts the last `<history>` block
   * and returns it as individual history entry strings.
   * Returns null if no prior session exists.
   */
  private _loadPreviousHistory(): string[] | null {
    try {
      const logDir = resolve(this.tempDir, 'model_responses');
      if (!existsSync(logDir)) return null;

      const sessions = listRecentSessions(logDir, 10);
      if (sessions.length === 0) return null;

      // Exclude current process's own log file
      const currentLog = `model_responses_${process.pid}.txt`;
      const prior = sessions.filter(s => basename(s.path) !== currentLog);
      if (prior.length === 0) return null;

      // Read the most recent prior session and extract the full <history> block
      const content = readFileSync(prior[0].path, 'utf-8');
      const match = content.match(/<history>([\s\S]*?)<\/history>/i);
      if (!match) return null;

      const histText = match[1].trim();
      if (!histText) return null;

      return histText.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    } catch {
      return null;
    }
  }

  /**
   * Execute a single task by creating a handler and running the agent loop.
   */
  private async _executeTask(task: TaskEntry): Promise<void> {
    const { source, images, display } = task;
    let query = task.query;

    // ── Auto-load previous session history ───────────────────────────────────
    const priorHistory = this._loadPreviousHistory();

    if (priorHistory) {
      // Inject session context into the query
      const summary = priorHistory.slice(-5).join('\n');
      query = `[SYSTEM] 已加载上轮对话摘要 (${priorHistory.length} 轮历史)\n${summary}\n---\n${query}`;
      console.log(`[GeneraticAgent] Loaded ${priorHistory.length} history entries from previous session.`);
    }

    // Select the LLM client
    const llmClient = this.nextLLM();
    if (!llmClient) {
      display.push({ done: 'No LLM session configured. Please set up mykey.json.' });
      display.done();
      return;
    }

    // Create the handler, passing prior history if available
    const handler = new GenericAgentHandler(this, priorHistory, this.tempDir);

    // Carry forward key_info from previous handler (same process), aligned with Python
    if (this.handler && this.handler.working && this.handler.working['key_info']) {
      let ki = String(this.handler.working['key_info'])
        .replace(/\n\[SYSTEM\] 此为.*?工作记忆[。\n]*/g, ''); // clean old warnings
      handler.working['key_info'] = ki;
      handler.working['passed_sessions'] =
        (this.handler.working['passed_sessions'] || 0) + 1;
      const ps = handler.working['passed_sessions'] as number;
      if (ps > 0) {
        handler.working['key_info'] = (handler.working['key_info'] as string) +
          `\n[SYSTEM] 此为 ${ps} 个对话前设置的key_info，若已在新任务，先更新或清除工作记忆。\n`;
      }
    }

    // Pass images if provided
    if (images && images.length > 0 && 'setImages' in handler && typeof handler.setImages === 'function') {
      handler.setImages(images);
    }

    // Log task start
    writeLLMLog('Task', JSON.stringify({ query, source, images_count: images.length }, null, 2));

    console.log(`[GeneraticAgent] Processing: "${query.slice(0, 80)}${query.length > 80 ? '...' : ''}"`);

    // Load the tools schema
    const toolsSchemaPath = resolve(SCRIPT_DIR, 'assets', 'tools_schema.json');
    let toolsSchema: ToolSchema[] = [];
    try {
      if (existsSync(toolsSchemaPath)) {
        toolsSchema = JSON.parse(readFileSync(toolsSchemaPath, 'utf-8'));
      }
    } catch { /* ignore */ }

    // Langfuse: start agent task trace
    startAgentTaskTrace(query);

    // Run the agent loop
    try {
      for await (const chunk of agentRunnerLoop(
        llmClient.client,
        '',
        query,
        handler,
        toolsSchema,
        40,
        true
      )) {
        display.push({ next: chunk });
      }
      display.done();
      // Langfuse: end agent task trace (success)
      endAgentTaskTrace('Task completed successfully');
    } catch (err) {
      // Langfuse: end agent task trace (error)
      endAgentTaskTrace(undefined, { error: String(err) });
      if (!this.abortSignal.aborted) {
        throw err;
      }
      display.push({ done: 'Task aborted.' });
      display.done('aborted');
    }

    // ── Carry forward history and handler for next task ──────────────────────
    if (handler.history_info && handler.history_info.length > 0) {
      this.history = [...handler.history_info];
    }
    this.handler = handler;
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  /**
   * Get the temporary directory path.
   */
  getTempDir(): string {
    return this.tempDir;
  }

  /**
   * Check if the agent is currently processing a task.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of pending tasks.
   */
  get pendingTaskCount(): number {
    return this.taskQueue.length;
  }
}
