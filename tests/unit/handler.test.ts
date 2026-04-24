import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { GenericAgentHandler, consumeFile } from '../../src/core/handler.js';
import { MockResponse } from '../../src/core/types.js';

// ─── mock codeRunner to avoid real subprocess spawn ──────────────────────────

const { codeRunSpy } = vi.hoisted(() => ({ codeRunSpy: vi.fn() }));

vi.mock('../../src/tools/code-runner.ts', () => ({
  codeRun: codeRunSpy,
  smartFormat: (data: unknown, maxStrLen = 100, omitStr = ' ... ') => {
    const s = typeof data === 'string' ? data : String(data);
    if (s.length < maxStrLen + omitStr.length * 2) return s;
    return s.slice(0, Math.floor(maxStrLen / 2)) + omitStr + s.slice(-Math.floor(maxStrLen / 2));
  },
}));

// ─── helpers ─────────────────────────────────────────────────────────────────

async function drainGen<T>(gen: AsyncGenerator<string, T>): Promise<T> {
  let result: IteratorResult<string, T>;
  while (!(result = await gen.next()).done) { /* drain */ }
  return result.value;
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe('GenericAgentHandler', () => {
  let handler: GenericAgentHandler;
  let tmpDir: string;
  const resp = new MockResponse('', '', [], '');

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ga-test-'));
    handler = new GenericAgentHandler(null, null, tmpDir);
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* best effort */ }
  });

  // 1 ─ constructor ───────────────────────────────────────────────────────
  it('constructor sets cwd, working, history_info, plan-mode defaults', () => {
    expect(handler.cwd).toBe(tmpDir);
    expect(handler.working).toEqual({});
    expect(handler.history_info).toEqual([]);
    expect(handler._inPlanMode).toBe(false);
    expect(handler._planSteps).toEqual([]);
  });

  // 2 ─ do_no_tool ────────────────────────────────────────────────────────
  it('do_no_tool returns Ready with null next_prompt (no checkpoint)', async () => {
    const o = await drainGen(handler.do_no_tool({}, resp));
    expect(o.data).toBe('Ready');
    expect(o.next_prompt).toBeNull();
  });

  it('do_no_tool returns key_info prompt when key_info exists', async () => {
    handler.working['key_info'] = 'draft';
    const o = await drainGen(handler.do_no_tool({}, resp));
    expect(o.data).toBe('no_tool – but key_info exists');
    expect(o.next_prompt).toContain('draft');
  });

  // 3 ─ do_ask_user ───────────────────────────────────────────────────────
  it('do_ask_user writes question and returns answer', async () => {
    const gen = handler.do_ask_user({ question: 'OK?' }, resp);
    const { value } = await gen.next();          // triggers writeFileSync
    expect(value).toContain('Asking user: OK?');
    expect(existsSync(resolve(tmpDir, '.ga_question'))).toBe(true);

    writeFileSync(resolve(tmpDir, '.ga_answer'), 'yes', 'utf-8');
    const o = await drainGen(gen);
    expect(o.data).toBe('yes');
  });

  // 4 ─ do_code_run ───────────────────────────────────────────────────────
  it('do_code_run returns error when no code is provided', async () => {
    const o = await drainGen(handler.do_code_run({}, resp));
    expect(o.data).toContain('No code provided');
  });

  it('do_code_run blocks execution in plan mode', async () => {
    handler._inPlanMode = true;
    const o = await drainGen(
      handler.do_code_run({ code: 'print("hi")', language: 'python' }, resp),
    );
    expect(o.data).toContain('Plan Mode');
  });

  // 5 ─ do_file_write ─────────────────────────────────────────────────────
  it('do_file_write creates a file with the given content', async () => {
    const o = await drainGen(
      handler.do_file_write({ file: 'out.txt', content: 'hello world' }, resp),
    );
    expect(o.data).toContain('File written');
    expect(readFileSync(resolve(tmpDir, 'out.txt'), 'utf-8')).toBe('hello world');
  });

  // 6 ─ do_file_read ──────────────────────────────────────────────────────
  it('do_file_read reads a file and returns its content', async () => {
    writeFileSync(resolve(tmpDir, 'r.txt'), 'line1\nline2\nline3', 'utf-8');
    const o = await drainGen(handler.do_file_read({ file: 'r.txt' }, resp));
    expect(o.data).toContain('line1');
    expect(o.data).toContain('line2');
  });

  // 7 ─ do_file_patch ─────────────────────────────────────────────────────
  it('do_file_patch patches a file successfully', async () => {
    writeFileSync(resolve(tmpDir, 'p.txt'), 'hello world', 'utf-8');
    const o = await drainGen(
      handler.do_file_patch({ file: 'p.txt', patch: 'hello world' }, resp),
    );
    expect(o.data).toHaveProperty('status');
  });

  // 8 ─ do_update_working_checkpoint ──────────────────────────────────────
  it('do_update_working_checkpoint saves key_info to working and file', async () => {
    const o = await drainGen(
      handler.do_update_working_checkpoint({ key_info: 'cp1', related_sop: 'done' }, resp),
    );
    expect(handler.working['key_info']).toBe('cp1');
    expect(existsSync(resolve(tmpDir, 'working_checkpoint.txt'))).toBe(true);
    expect(o.data).toBe('working key_info updated');
  });

  // 9 ─ do_start_long_term_update ─────────────────────────────────────────
  it('do_start_long_term_update creates the update file', async () => {
    const o = await drainGen(
      handler.do_start_long_term_update({ content: 'LTM entry' }, resp),
    );
    expect(o.data).toBe('Long-term update file created');
    expect(existsSync(resolve(tmpDir, '.ga_long_term_update'))).toBe(true);
  });

  // 10 ─ do_web_scan / do_web_execute_js ───────────────────────────────────
  it('do_web_scan returns placeholder', async () => {
    const o = await drainGen(
      handler.do_web_scan({ url: 'http://x.com' }, resp),
    );
    expect(o.data).toContain('web_scan');
  });

  it('do_web_execute_js returns placeholder', async () => {
    const o = await drainGen(
      handler.do_web_execute_js({ script: '1+1' }, resp),
    );
    expect(o.data).toContain('web_execute_js');
  });

  // 11 ─ _getAnchorPrompt (plan mode) ─────────────────────────────────────
  it('_getAnchorPrompt includes plan_mode tags when in plan mode', () => {
    handler._inPlanMode = true;
    handler._planSteps = ['Check files', 'Run analysis'];
    handler._planCompletion = { 'Check files': false, 'Run analysis': false };
    const prompt = handler._getAnchorPrompt();
    expect(prompt).toContain('plan_mode');
    expect(prompt).toContain('Check files');
  });

  // 12 ─ consumeFile ──────────────────────────────────────────────────────
  it('consumeFile reads and deletes the file', () => {
    const p = resolve(tmpDir, 'c.txt');
    writeFileSync(p, 'contents', 'utf-8');
    const result = consumeFile(tmpDir, 'c.txt');
    expect(result).toBe('contents');
    expect(existsSync(p)).toBe(false);
  });
});
