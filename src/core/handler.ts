import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

import type { MockResponse, ToolCallRecord, ToolResult } from '../core/types.js';
import { StepOutcome } from '../core/types.js';
import { BaseHandler } from '../core/agent-loop.js';

import {
  codeRun,
} from '../tools/code-runner.js';
import {
  fileRead,
  filePatch,
  fileWrite,
  expandFileRefs,
} from '../tools/file-io.js';
import type { FileReadOptions } from '../tools/file-io.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read a file from `dir` and immediately unlink it.
 * Returns the file contents, or `undefined` if the file does not exist.
 * This is used as a simple IPC mechanism (e.g. ask_user writes a response file).
 */
export function consumeFile(
  dir: string | undefined,
  file: string,
): string | undefined {
  if (dir) {
    const fullPath = resolve(dir, file);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, { encoding: 'utf-8' });
      try {
        unlinkSync(fullPath);
      } catch {
        /* best-effort unlink */
      }
      return content;
    }
  }
  return undefined;
}

/**
 * Format an error object (or string) into a consistent error string.
 */
function formatError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

// ─── History entry type ─────────────────────────────────────────────────────

export type HistoryEntry = string;

// ─── GenericAgentHandler ────────────────────────────────────────────────────

export class GenericAgentHandler extends BaseHandler {
  /** Reference to the parent agent/node */
  parent: any;

  /** Working-memory key-value store */
  working: Record<string, unknown>;

  /** Current working directory (for relative-path resolution) */
  cwd: string;

  /** Accumulated history info entries */
  history_info: HistoryEntry[];

  /** Code-stop signal list – populated when user interrupts a code run */
  code_stop_signal: string[];

  /** Whether the handler is currently in plan mode */
  _inPlanMode: boolean;

  /** Completion criteria tracked during plan mode */
  _planCompletion: Record<string, boolean>;

  /** Current plan steps (when in plan mode) */
  _planSteps: string[];

  constructor(parent: any, last_history: HistoryEntry[] | null = null, cwd: string = './temp') {
    super();
    this.parent = parent;
    this.working = {};
    this.cwd = cwd;
    this.current_turn = 0;
    this.history_info = last_history ? [...last_history] : [];
    this.code_stop_signal = [];
    this._done_hooks = [];

    // Plan-mode state
    this._inPlanMode = false;
    this._planCompletion = {};
    this._planSteps = [];
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  /** Resolve a relative path to an absolute path rooted at `cwd`. */
  _getAbsPath(path: string): string {
    if (!path) return '';
    return resolve(this.cwd, path);
  }

  /** Resolve a relative path relative to the current working directory. */
  _resolvePath(path: string): string {
    if (!path) return this._getAbsPath('');
    return resolve(this.cwd, path);
  }

  /** Overridden: called when the agent wants to exit. */
  _exit(): StepOutcome {
    return new StepOutcome(null, 'exit', true);
  }

  // ── Tool: code_run ──────────────────────────────────────────────────────

  async *do_code_run(
    args: Record<string, unknown>,
    response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    const code = String(args['code'] || args['script'] || '');
    if (!code) {
      return new StepOutcome(
        'No code provided',
        this._getAnchorPrompt(),
        false,
      );
    }

    // Detect language
    const lang = String(
      args['language'] ||
      args['lang'] ||
      args['type'] ||
      'python',
    ).toLowerCase();

    // If in plan mode, do not actually execute
    if (this._inPlanMode) {
      return new StepOutcome(
        '[Plan Mode] code run blocked',
        this._getAnchorPrompt(),
        false,
      );
    }

    // Interrupted by stop signal?
    const sigFile = resolve(this.cwd, '.ga_stop_code');
    if (existsSync(sigFile)) {
      try { unlinkSync(sigFile); } catch { /* ok */ }
      return new StepOutcome(
        'Code run aborted by user interrupt.',
        this._getAnchorPrompt(),
        false,
      );
    }

    yield `Running ${lang} code...\n`;

    // Optional stop-signal check
    if (this.code_stop_signal.length > 0) {
      return new StepOutcome(
        'Code run skipped – stop signal active',
        'Please check the code stop signal before continuing.',
        false,
      );
    }

    try {
      // Extract code block if LLM wrapped in markdown
      const extractedCode = this._extractCodeBlock(response, lang);
      const codeToRun = extractedCode || code;

      // Call the code runner (async generator that yields output strings)
      const runGen = codeRun(codeToRun, lang, (args['timeout'] as number) || 600, this.cwd);

      let runResult = '';
      for await (const chunk of runGen) {
        runResult += chunk;
        yield chunk;
      }

      return new StepOutcome(
        runResult,
        this._getAnchorPrompt(),
        false,
      );
    } catch (err) {
      const errStr = formatError(err);
      yield `Error running code: ${errStr}\n`;
      return new StepOutcome(
        `Error: ${errStr}`,
        this._getAnchorPrompt(),
        false,
      );
    }
  }

  // ── Tool: ask_user ──────────────────────────────────────────────────────

  async *do_ask_user(
    args: Record<string, unknown>,
    _response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    const question = String(args['question'] || args['prompt'] || args['msg'] || '');
    if (!question) {
      return new StepOutcome(
        'No question provided',
        this._getAnchorPrompt(),
        false,
      );
    }

    // Write the question file so the parent process can relay to the user
    const questionFile = resolve(this.cwd, '.ga_question');
    writeFileSync(questionFile, question, 'utf-8');

    yield `Asking user: ${question.slice(0, 200)}\n`;

    // Poll for the answer file (up to ~60 seconds)
    const maxWaitMs = (args['timeout'] as number) || 60000;
    const pollInterval = 500;
    const start = Date.now();
    let answer: string | undefined;

    while (Date.now() - start < maxWaitMs) {
      answer = consumeFile(this.cwd, '.ga_answer');
      if (answer !== undefined) break;
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    if (answer === undefined) {
      // Check if question file was consumed externally
      if (!existsSync(resolve(this.cwd, '.ga_question'))) {
        answer = consumeFile(this.cwd, '.ga_answer') || '(no response)';
      } else {
        // Clean up and report timeout
        try { unlinkSync(questionFile); } catch { /* ok */ }
        return new StepOutcome(
          'User did not respond in time',
          this._getAnchorPrompt(),
          false,
        );
      }
    }

    return new StepOutcome(answer, this._getAnchorPrompt(), false);
  }

  // ── Tool: web_scan ──────────────────────────────────────────────────────

  async *do_web_scan(
    args: Record<string, unknown>,
    _response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    const url = String(args['url'] || args['q'] || '');
    if (!url) {
      return new StepOutcome(
        'No URL provided for web scan',
        this._getAnchorPrompt(),
        false,
      );
    }

    yield `Scanning: ${url}\n`;

    return new StepOutcome(
      'web_scan: browser-based page scanning (tmwebdriver required)',
      this._getAnchorPrompt(),
      false,
    );
  }

  // ── Tool: web_execute_js ────────────────────────────────────────────────

  async *do_web_execute_js(
    args: Record<string, unknown>,
    _response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    const script = String(args['script'] || args['code'] || args['js'] || '');
    const url = String(args['url'] || '');

    if (!script) {
      return new StepOutcome(
        'No script provided for web JS execution',
        this._getAnchorPrompt(),
        false,
      );
    }

    yield `Executing JS${url ? ` on ${url}` : ''}...\n`;

    return new StepOutcome(
      'web_execute_js: use TMWebDriver executeJs directly',
      this._getAnchorPrompt(),
      false,
    );
  }

  // ── Tool: file_read ─────────────────────────────────────────────────────

  async *do_file_read(
    args: Record<string, unknown>,
    _response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    const filePath = String(args['file'] || args['path'] || args['file_path'] || '');
    if (!filePath) {
      return new StepOutcome(
        'No file path provided',
        this._getAnchorPrompt(),
        false,
      );
    }

    const fullPath = this._resolvePath(filePath);

    try {
      const options: FileReadOptions = { regex: args['regex'] as string | undefined };
      if (args['offset'] !== undefined || args['limit'] !== undefined) {
        const s = args['offset'] !== undefined ? Number(args['offset']) + 1 : 1;
        const e = args['limit'] !== undefined ? s + Number(args['limit']) - 1 : 999999;
        options.lineRange = [s, e];
      }
      const content = await fileRead(fullPath, options);

      if (content.status === 'error') {
        return new StepOutcome(
          content.msg || `File not found: ${filePath}`,
          this._getAnchorPrompt(),
          false,
        );
      }

      yield content.content.slice(0, 500);
      if (content.content.length > 500) yield '...(truncated preview)\n';

      return new StepOutcome(content.content, this._getAnchorPrompt(), false);
    } catch (err) {
      return new StepOutcome(
        `Error reading file: ${formatError(err)}`,
        this._getAnchorPrompt(),
        false,
      );
    }
  }

  // ── Tool: file_write ────────────────────────────────────────────────────

  async *do_file_write(
    args: Record<string, unknown>,
    _response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    const filePath = String(args['file'] || args['path'] || args['file_path'] || '');
    const content = String(args['content'] || args['data'] || args['text'] || '');
    let mode: string = String(args['mode'] || 'overwrite');

    if (!filePath) {
      return new StepOutcome(
        'No file path provided',
        this._getAnchorPrompt(),
        false,
      );
    }

    // In plan mode, simulate without writing
    if (this._inPlanMode) {
      return new StepOutcome(
        `[Plan Mode] Would write ${content.length} bytes to ${basename(this._resolvePath(filePath))}`,
        this._getAnchorPrompt(),
        false,
      );
    }

    // Expand any file references in the content
    let expandedContent = content;
    try {
      expandedContent = expandFileRefs(content, this.cwd);
    } catch {
      /* best effort */
    }

    const fullPath = this._resolvePath(filePath);

    try {
      await fileWrite(fullPath, expandedContent, mode as 'overwrite' | 'append');
      yield `Wrote ${expandedContent.length} bytes to ${basename(fullPath)}\n`;
      return new StepOutcome(
        `File written: ${basename(fullPath)} (${expandedContent.length} bytes)`,
        this._getAnchorPrompt(),
        false,
      );
    } catch (err) {
      return new StepOutcome(
        `Error writing file: ${formatError(err)}`,
        this._getAnchorPrompt(),
        false,
      );
    }
  }

  // ── Tool: file_patch ────────────────────────────────────────────────────

  async *do_file_patch(
    args: Record<string, unknown>,
    _response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    const filePath = String(args['file'] || args['path'] || args['file_path'] || '');
    const patch = String(args['patch'] || args['diff'] || '');

    if (!filePath || !patch) {
      return new StepOutcome(
        'File path and patch content are required',
        this._getAnchorPrompt(),
        false,
      );
    }

    // In plan mode, simulate
    if (this._inPlanMode) {
      return new StepOutcome(
        `[Plan Mode] Would patch ${basename(this._resolvePath(filePath))}`,
        this._getAnchorPrompt(),
        false,
      );
    }

    const fullPath = this._resolvePath(filePath);

    try {
      const result = await filePatch(fullPath, patch, '');
      yield `Patched ${basename(fullPath)}\n`;
      return new StepOutcome(result, this._getAnchorPrompt(), false);
    } catch (err) {
      return new StepOutcome(
        `Error patching file: ${formatError(err)}`,
        this._getAnchorPrompt(),
        false,
      );
    }
  }

  // ── Tool: update_working_checkpoint ─────────────────────────────────────

  async *do_update_working_checkpoint(
    args: Record<string, unknown>,
    _response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    const keyInfo = String(args['key_info'] || '');
    if (keyInfo) {
      // Write to the working checkpoint file
      const cpFile = resolve(this.cwd, 'working_checkpoint.txt');
      writeFileSync(cpFile, keyInfo, 'utf-8');
      this.working['key_info'] = keyInfo;
      yield `Working checkpoint updated (${keyInfo.length} bytes).\n`;
    }

    // Store related SOP reference
    const relatedSop = String(args['related_sop'] || '');
    if (relatedSop) {
      this.working['related_sop'] = relatedSop;
    }

    this.working['passed_sessions'] = 0;

    return new StepOutcome(
      'working key_info updated',
      this._getAnchorPrompt(),
      false,
    );
  }

  // ── Tool: no_tool ───────────────────────────────────────────────────────

  async *do_no_tool(
    _args: Record<string, unknown>,
    _response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    // When the LLM produces no tool calls, check plan mode first
    if (this._inPlanMode) {
      return this._checkPlanCompletion();
    }

    // Check if there is a working key_info that suggests continuation
    const cp = this.working['key_info'] as string | undefined;
    if (cp) {
      return new StepOutcome(
        'no_tool – but key_info exists',
        `Please review the working key_info and continue if needed:\n\`\`\`\n${cp}\n\`\`\``,
        false,
      );
    }

    return new StepOutcome(
      'Ready',
      null as unknown as string,  // null next_prompt triggers CURRENT_TASK_DONE
      false,
    );
  }

  // ── Tool: start_long_term_update ────────────────────────────────────────

  async *do_start_long_term_update(
    args: Record<string, unknown>,
    _response: MockResponse,
  ): AsyncGenerator<string, StepOutcome> {
    const updateContent = String(args['content'] || args['update'] || '');
    const updateFile = resolve(this.cwd, '.ga_long_term_update');

    writeFileSync(updateFile, updateContent, 'utf-8');
    yield `Long-term update started (${updateContent.length} bytes).\n`;

    return new StepOutcome(
      'Long-term update file created',
      this._getAnchorPrompt(),
      false,
    );
  }

  // ── Plan-mode methods ───────────────────────────────────────────────────

  /** Check if the agent is currently in plan mode. */
  get _in_plan_mode(): boolean {
    return this._inPlanMode;
  }

  /** Exit plan mode. */
  _exit_plan_mode(): void {
    this._inPlanMode = false;
    this._planCompletion = {};
    this._planSteps = [];
  }

  /** Enter plan mode with the given plan content. */
  enter_plan_mode(rawPlan: string): void {
    this._inPlanMode = true;
    this._planSteps = rawPlan
      .split(/\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    this._planCompletion = {};
    for (const step of this._planSteps) {
      this._planCompletion[step] = false;
    }
  }

  /** Check whether all plan steps have been completed. */
  _checkPlanCompletion(): StepOutcome {
    const allDone = Object.values(this._planCompletion).every(Boolean);
    if (allDone) {
      this._exit_plan_mode();
      return new StepOutcome(
        'All plan steps completed',
        this._getAnchorPrompt(),
        false,
      );
    }

    // List remaining steps
    const remaining = this._planSteps.filter(
      (s) => !this._planCompletion[s],
    );
    return new StepOutcome(
      `${remaining.length} plan steps remaining`,
      `Still in plan mode. Remaining steps:\n${remaining.map((s) => `- ${s}`).join('\n')}`,
      false,
    );
  }

  /** Mark a plan step as complete. Called by individual tool handlers. */
  _markPlanStepComplete(stepHint: string): void {
    if (!this._inPlanMode) return;

    // Try to find the closest matching step
    for (const step of this._planSteps) {
      if (!this._planCompletion[step] && step.includes(stepHint)) {
        this._planCompletion[step] = true;
        return;
      }
    }
    // If no match, mark the first uncompleted step
    for (const step of this._planSteps) {
      if (!this._planCompletion[step]) {
        this._planCompletion[step] = true;
        return;
      }
    }
  }

  // ── Anchor prompt ───────────────────────────────────────────────────────

  /**
   * Build the "anchor" prompt that is appended at the end of each turn.
   * This includes working-memory hints, history, and task directives.
   */
  _getAnchorPrompt(): string {
    const parts: string[] = [];

    // Always include working memory header and current turn
    const hStr = this.history_info.slice(-20).join('\n');
    parts.push(`\n### [WORKING MEMORY]\n<history>\n${hStr}\n</history>\nCurrent turn: ${this.current_turn}`);

    // Append working key_info
    const ki = this.working['key_info'] as string | undefined;
    if (ki) {
      parts.push(`<key_info>${ki}</key_info>`);
    }

    // Append working summary
    const summary = this.working['history_summary'] as string | undefined;
    if (summary) {
      const lines = summary.split('\n---\n');
      const recentSummary = lines.slice(-3).join(' | ');
      if (recentSummary.length > 200) {
        parts.push(
          `<key_info>\nRecent activity: ...${recentSummary.slice(-200)}\n</key_info>`,
        );
      } else if (recentSummary) {
        parts.push(
          `<key_info>\n${recentSummary}\n</key_info>`,
        );
      }
    }

    // Plan-mode directive
    if (this._inPlanMode) {
      const activeSteps = this._planSteps.filter(
        (s) => !this._planCompletion[s],
      );
      parts.push(
        '<plan_mode>\n' +
          'You are in PLAN MODE. Do not execute any code or write files. ' +
          'Simulate tool outputs instead. Focus on completing these steps:\n' +
          activeSteps.map((s) => `- ${s}`).join('\n') +
          '\n</plan_mode>',
      );
    }

    return parts.join('\n\n');
  }

  // ── Turn end callback ───────────────────────────────────────────────────

  override turn_end_callback(
    response: MockResponse,
    tool_calls: ToolCallRecord[],
    tool_results: ToolResult[],
    turn: number,
    next_prompt: string,
    exit_reason: Record<string, unknown>,
  ): string {
    let finalPrompt = next_prompt;

    // If no next prompt from tool outcomes and not exiting, produce a default
    if (!finalPrompt && Object.keys(exit_reason).length === 0) {
      finalPrompt = 'Please continue working on the task.';
    }

    // Prepend instruction directive
    const lang = (process.env['GA_LANG'] || 'en').toLowerCase();
    const anchor = this._getAnchorPrompt();

    if (lang === 'zh' || lang === 'cn') {
      finalPrompt =
        '继续执行上一轮未完成的工作。不得回复"好的"或"已完成"除非确实完成。\n\n' +
        (anchor ? anchor + '\n\n' : '') +
        finalPrompt;
    } else {
      finalPrompt =
        'Continue working on the tasks from the previous turn. Do not reply "OK" or "Done" unless truly finished.\n\n' +
        (anchor ? anchor + '\n\n' : '') +
        finalPrompt;
    }

    // Store history info about this turn
    if (tool_calls.length > 0) {
      const toolNames = [...new Set(tool_calls.map((tc) => tc.tool_name))];
      this.history_info.push(
        `Turn ${turn}: used ${toolNames.join(', ')} (${tool_results.length} results)`,
      );
    }

    return finalPrompt;
  }

  // ── Utility: extract code from LLM response ─────────────────────────────

  /**
   * Extract the last code block matching the given `code_type` from the LLM
   * response content. Returns the code string, or null if no match found.
   */
  _extractCodeBlock(
    response: MockResponse,
    code_type: string,
  ): string | null {
    const typeMap: Record<string, string> = {
      python: 'python|py',
      powershell: 'powershell|ps1|pwsh',
      bash: 'bash|sh|shell',
    };
    const pattern = typeMap[code_type] || escapeRegex(code_type);
    const regex = new RegExp(
      `\`\`\`(?:${pattern})\\n(.*?)\\n\`\`\``,
      'gs',
    );
    const content = response.content;
    const matches = [...content.matchAll(regex)];
    return matches.length > 0 ? matches[matches.length - 1][1].trim() : null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
