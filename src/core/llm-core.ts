import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import type { SessionConfig, MixinConfig, MyKeys, ContentBlock, Message, ToolSchema } from './types.js';
import { MockToolCall, MockResponse } from './types.js';
import { loadMyKeys, getProxy } from '../config/config-loader.js';
import { startLLMGeneration, endLLMGeneration } from '../plugins/langfuse-tracing.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptDir = resolve(__dirname, '..', '..');

const require = createRequire(import.meta.url);

// ─── Lazy config loading ────────────────────────────────────────────────────

let _mykeys: MyKeys | null = null;
let _proxies: Record<string, string> | null | undefined = undefined;

export function getMyKeys(): MyKeys {
  if (_mykeys) return _mykeys;
  _mykeys = loadMyKeys();
  // Initialize Langfuse tracing when env vars are set
  try {
    const { initLangfuse } = require('../plugins/langfuse-tracing');
    initLangfuse(_mykeys['langfuse_config'] as Record<string, unknown> | undefined);
  } catch { /* optional */ }
  return _mykeys;
}

export function getProxies(): Record<string, string> | null {
  if (_proxies !== undefined) return _proxies;
  _proxies = getProxy();
  return _proxies;
}

// Re-export for convenience - same names as Python
export const mykeys = new Proxy({} as MyKeys, {
  get(_target, prop) {
    return getMyKeys()[prop as string];
  },
  ownKeys() { return Object.keys(getMyKeys()); },
  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
});

export const proxies = new Proxy({} as Record<string, string>, {
  get() { return getProxies() || {}; },
});

// ─── RESP_CACHE_KEY ─────────────────────────────────────────────────────────

const RESP_CACHE_KEY = crypto.randomUUID();

// ─── Helper: compress_history_tags ──────────────────────────────────────────

let _cdCount = 0;

export function compressHistoryTags(messages: Message[], keepRecent: number = 10, maxLen: number = 800, force: boolean = false): Message[] {
  _cdCount += 1;
  if (force) _cdCount = 0;
  if (_cdCount % 5 !== 0) return messages;

  const _before = messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);

  const _pats: Record<string, RegExp> = {};
  for (const tag of ['thinking', 'think', 'tool_use', 'tool_result']) {
    _pats[tag] = new RegExp(`(<${tag}>)([\\s\\S]*?)(</${tag}>)`, 'g');
  }
  const _histPat = /<(history|key_info)>[\s\S]*?<\/\1>/g;

  function truncStr(s: string): string {
    if (typeof s === 'string' && s.length > maxLen) {
      return s.slice(0, maxLen / 2) + '\n...[Truncated]...\n' + s.slice(-maxLen / 2);
    }
    return s;
  }

  function trunc(text: string): string {
    text = text.replace(_histPat, (_, tag) => `<${tag}>[...]</${tag}>`);
    for (const pat of Object.values(_pats)) {
      text = text.replace(pat, (_, open, body, close) => open + truncStr(body) + close);
    }
    return text;
  }

  for (let i = 0; i < messages.length; i++) {
    if (i >= messages.length - keepRecent) break;
    const msg = messages[i];
    const c = msg.content;
    if (typeof c === 'string') {
      msg.content = trunc(c);
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (typeof b !== 'object' || b === null) continue;
        const t = b.type;
        if (t === 'text' && typeof b.text === 'string') {
          b.text = trunc(b.text);
        } else if (t === 'tool_result') {
          if (typeof b.content === 'string') {
            b.content = truncStr(b.content);
          } else if (Array.isArray(b.content)) {
            for (const sub of b.content) {
              if (typeof sub === 'object' && sub !== null && sub.type === 'text') {
                sub.text = truncStr(sub.text || '');
              }
            }
          }
        } else if (t === 'tool_use' && b.input && typeof b.input === 'object') {
          for (const k of Object.keys(b.input)) {
            b.input[k] = truncStr(String(b.input[k]));
          }
        }
      }
    }
  }
  const _after = messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
  console.log(`[Cut] ${_before} -> ${_after}`);
  return messages;
}

// ─── Helper: _sanitize_leading_user_msg ─────────────────────────────────────

export function sanitizeLeadingUserMsg(msg: Message): Message {
  msg = { ...msg };
  const content = msg.content;
  if (!Array.isArray(content)) return msg;
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    if (block.type === 'tool_result') {
      const c = block.content;
      if (Array.isArray(c)) {
        texts.push(...c.filter((b): b is { type: string; text: string } => typeof b === 'object' && b !== null && b.type === 'text').map(b => b.text || ''));
      } else {
        texts.push(String(c));
      }
    } else if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    }
  }
  msg.content = [{ type: 'text', text: texts.join('\n') }];
  return msg;
}

// ─── Helper: trim_messages_history ──────────────────────────────────────────

export function trimMessagesHistory(history: Message[], contextWin: number): void {
  compressHistoryTags(history);
  let cost = history.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
  console.log(`[Debug] Current context: ${cost} chars, ${history.length} messages.`);
  if (cost > contextWin * 3) {
    compressHistoryTags(history, 4, 0, true);
    const target = contextWin * 3 * 0.6;
    while (history.length > 5 && cost > target) {
      history.shift();
      while (history.length > 0 && history[0].role !== 'user') history.shift();
      if (history.length > 0 && history[0].role === 'user') {
        history[0] = sanitizeLeadingUserMsg(history[0]);
      }
      cost = history.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
    }
    console.log(`[Debug] Trimmed context, current: ${cost} chars, ${history.length} messages.`);
  }
}

// ─── Helper: auto_make_url ──────────────────────────────────────────────────

export function autoMakeUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (b.endsWith('$')) return b.slice(0, -1).replace(/\/+$/, '');
  if (b.endsWith(p)) return b;
  if (/\/v\d+(\/|$)/.test(b)) return `${b}/${p}`;
  return `${b}/v1/${p}`;
}

// ─── Record usage ───────────────────────────────────────────────────────────

let _recordedUsage: { input: number; output: number; mode: string } | null = null;

export function getLastUsage() { return _recordedUsage; }

function recordUsage(usage: Record<string, unknown>, apiMode: string): void {
  if (!usage) return;
  if (apiMode === 'responses') {
    const details = (usage.input_tokens_details || {}) as Record<string, number>;
    const cached = details.cached_tokens || 0;
    const inp = (usage.input_tokens as number) || 0;
    console.log(`[Cache] input=${inp} cached=${cached}`);
  } else if (apiMode === 'chat_completions') {
    const details = (usage.prompt_tokens_details || {}) as Record<string, number>;
    const cached = details.cached_tokens || 0;
    const inp = (usage.prompt_tokens as number) || 0;
    console.log(`[Cache] input=${inp} cached=${cached}`);
  } else if (apiMode === 'messages') {
    const ci = (usage.cache_creation_input_tokens as number) || 0;
    const cr = (usage.cache_read_input_tokens as number) || 0;
    const inp = (usage.input_tokens as number) || 0;
    console.log(`[Cache] input=${inp} creation=${ci} read=${cr}`);
  }
  _recordedUsage = {
    input: (usage.input_tokens as number) || (usage.prompt_tokens as number) || 0,
    output: (usage.output_tokens as number) || (usage.completion_tokens as number) || 0,
    mode: apiMode,
  };
}

// ─── Temperature clamp per model ────────────────────────────────────────────

/**
 * Clamp temperature to the vendor-specific legal range.
 * Anthropic models: 0.0-1.0 (default 1.0, omit below 0.01)
 * MiniMax models: 0.01-1.0
 * Kimi/Moonshot: fixed at 1.0
 */
export function clampTemperature(model: string, temperature: number): number {
  const ml = model.toLowerCase();
  if (ml.includes('kimi') || ml.includes('moonshot')) return 1.0;
  if (ml.includes('minimax')) return Math.max(0.01, Math.min(temperature, 1.0));
  return Math.max(0.0, Math.min(temperature, 1.0));
}

// ─── SSE Parser: Claude ─────────────────────────────────────────────────────

export async function* parseClaudeSSE(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string, ContentBlock[]> {
  const contentBlocks: ContentBlock[] = [];
  let currentBlock: ContentBlock | null = null;
  let toolJsonBuf = '';
  let stopReason: string | null = null;
  let gotMessageStop = false;
  let warn: string | null = null;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line) continue;
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trimStart();
        if (dataStr === '[DONE]') {
          gotMessageStop = true;
          break;
        }
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(dataStr);
        } catch (e) {
          console.log(`[SSE] JSON parse error: ${e}, line: ${dataStr.slice(0, 200)}`);
          continue;
        }

        const evtType = evt.type as string;

        if (evtType === 'message_start') {
          const msg = evt.message as Record<string, unknown> || {};
          const usage = msg.usage as Record<string, unknown> | undefined;
          if (usage) recordUsage(usage, 'messages');
        } else if (evtType === 'content_block_start') {
          const block = evt.content_block as Record<string, unknown> || {};
          if (block.type === 'text') {
            currentBlock = { type: 'text', text: '' };
          } else if (block.type === 'thinking') {
            currentBlock = { type: 'thinking', thinking: '', signature: '' };
          } else if (block.type === 'tool_use') {
            currentBlock = { type: 'tool_use', id: (block.id as string) || '', name: (block.name as string) || '', input: {} };
            toolJsonBuf = '';
          }
        } else if (evtType === 'content_block_delta') {
          const delta = evt.delta as Record<string, unknown> || {};
          if (delta.type === 'text_delta') {
            const text = (delta.text as string) || '';
            if (currentBlock && currentBlock.type === 'text') currentBlock.text = (currentBlock.text || '') + text;
            if (text) yield text;
          } else if (delta.type === 'thinking_delta') {
            if (currentBlock && currentBlock.type === 'thinking') currentBlock.thinking = (currentBlock.thinking || '') + ((delta.thinking as string) || '');
          } else if (delta.type === 'signature_delta') {
            if (currentBlock && currentBlock.type === 'thinking') currentBlock.signature = (currentBlock.signature || '') + ((delta.signature as string) || '');
          } else if (delta.type === 'input_json_delta') {
            toolJsonBuf += (delta.partial_json as string) || '';
          }
        } else if (evtType === 'content_block_stop') {
          if (currentBlock) {
            if (currentBlock.type === 'tool_use') {
              try {
                currentBlock.input = toolJsonBuf ? JSON.parse(toolJsonBuf) : {};
              } catch {
                currentBlock.input = { _raw: toolJsonBuf };
              }
            }
            contentBlocks.push(currentBlock);
            currentBlock = null;
          }
        } else if (evtType === 'message_delta') {
          const delta = evt.delta as Record<string, unknown> || {};
          stopReason = (delta.stop_reason as string) || stopReason;
          const outUsage = evt.usage as Record<string, number> | undefined;
          if (outUsage?.output_tokens) {
            console.log(`[Output] tokens=${outUsage.output_tokens} stop_reason=${stopReason}`);
          }
        } else if (evtType === 'message_stop') {
          gotMessageStop = true;
        } else if (evtType === 'error') {
          const err = evt.error as Record<string, unknown> || {};
          warn = `\n\n[SSE Error: ${err.message || String(err)}]`;
          break;
        }
      }
      if (gotMessageStop) break;
    }
  } catch (e) {
    if (!warn) warn = `\n\n[SSE Error: ${e}]`;
  }

  if (!warn) {
    if (!gotMessageStop && !stopReason) {
      warn = '\n\n[!!! 流异常中断，未收到完整响应 !!!]';
    } else if (stopReason === 'max_tokens') {
      warn = '\n\n[!!! Response truncated: max_tokens !!!]';
    }
  }
  if (warn) {
    console.log(`[WARN] ${warn.trim()}`);
    contentBlocks.push({ type: 'text', text: warn });
    yield warn;
  }
  return contentBlocks;
}

// ─── Tool args parsing ──────────────────────────────────────────────────────

export function tryParseToolArgs(raw: string): Record<string, unknown>[] {
  if (!raw) return [{}];
  try {
    return [JSON.parse(raw)];
  } catch { /* continue */ }

  const parts = raw.split(/(?<=\})(?=\{)/);
  if (parts.length > 1) {
    const parsed: Record<string, unknown>[] = [];
    for (const p of parts) {
      try {
        parsed.push(JSON.parse(p));
      } catch {
        return [{ _raw: raw }];
      }
    }
    return parsed;
  }
  return [{ _raw: raw }];
}

// ─── SSE Parser: OpenAI ─────────────────────────────────────────────────────

export async function* parseOpenAISSE(reader: ReadableStreamDefaultReader<Uint8Array>, apiMode: string = 'chat_completions'): AsyncGenerator<string, ContentBlock[]> {
  let contentText = '';
  const decoder = new TextDecoder();
  let buffer = '';

  if (apiMode === 'responses') {
    let seenDelta = false;
    const fcBuf: Record<number, { id: string; name: string; args: string }> = {};
    let currentFcIdx: number | null = null;

    const lines = await readAllLines(reader);
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trimStart();
      if (dataStr === '[DONE]') break;

      let evt: Record<string, unknown>;
      try { evt = JSON.parse(dataStr); } catch { continue; }

      const etype = evt.type as string;
      if (etype === 'response.output_text.delta') {
        const delta = (evt.delta as string) || '';
        if (delta) { seenDelta = true; contentText += delta; yield delta; }
      } else if (etype === 'response.output_text.done' && !seenDelta) {
        const text = (evt.text as string) || '';
        if (text) { contentText += text; yield text; }
      } else if (etype === 'response.output_item.added') {
        const item = evt.item as Record<string, unknown> || {};
        if (item.type === 'function_call') {
          const idx = (evt.output_index as number) || 0;
          fcBuf[idx] = { id: (item.call_id as string) || (item.id as string) || '', name: (item.name as string) || '', args: '' };
          currentFcIdx = idx;
        }
      } else if (etype === 'response.function_call_arguments.delta') {
        const idx = (evt.output_index as number) || currentFcIdx || 0;
        if (fcBuf[idx]) fcBuf[idx].args += (evt.delta as string) || '';
      } else if (etype === 'response.function_call_arguments.done') {
        const idx = (evt.output_index as number) || currentFcIdx || 0;
        if (fcBuf[idx]) fcBuf[idx].args = (evt.arguments as string) || fcBuf[idx].args;
      } else if (etype === 'error') {
        const err = evt.error as Record<string, unknown> || {};
        const emsg = err.message as string || String(err);
        if (emsg) { contentText += `Error: ${emsg}`; yield `Error: ${emsg}`; }
        break;
      } else if (etype === 'response.completed') {
        const resp = evt.response as Record<string, unknown> || {};
        const usage = resp.usage as Record<string, unknown> | undefined;
        if (usage) recordUsage(usage, apiMode);
        break;
      }
    }

    const blocks: ContentBlock[] = [];
    if (contentText) blocks.push({ type: 'text', text: contentText });
    for (const idx of Object.keys(fcBuf).map(Number).sort((a, b) => a - b)) {
      const fc = fcBuf[idx];
      const inps = tryParseToolArgs(fc.args);
      for (let i = 0; i < inps.length; i++) {
        let bid = fc.id || '';
        if (inps.length > 1) bid = bid ? `${bid}_${i}` : `split_${i}`;
        blocks.push({ type: 'tool_use', id: bid, name: fc.name, input: inps[i] });
      }
    }
    return blocks;
  } else {
    // chat_completions mode
    const tcBuf: Record<number, { id: string; name: string; args: string }> = {};
    const lines = await readAllLines(reader);
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trimStart();
      if (dataStr === '[DONE]') break;

      let evt: Record<string, unknown>;
      try { evt = JSON.parse(dataStr); } catch { continue; }

      const choices = (evt.choices as Record<string, unknown>[]) || [{}];
      const ch = choices[0] || {};
      const delta = (ch.delta as Record<string, unknown>) || {};
      if (delta.content) {
        const text = delta.content as string;
        contentText += text;
        yield text;
      }
      for (const tc of (delta.tool_calls as Record<string, unknown>[]) || []) {
        const idx = (tc.index as number) || 0;
        const hasName = !!(tc.function as Record<string, unknown>)?.name;
        if (!(idx in tcBuf)) {
          if (hasName || Object.keys(tcBuf).length === 0) {
            tcBuf[idx] = { id: (tc.id as string) || '', name: '', args: '' };
          } else {
            const maxIdx = Math.max(...Object.keys(tcBuf).map(Number));
            tcBuf[maxIdx] = tcBuf[maxIdx] || { id: '', name: '', args: '' };
          }
        }
        const targetIdx = (idx in tcBuf) ? idx : Math.max(...Object.keys(tcBuf).map(Number));
        if (hasName) tcBuf[targetIdx].name = (tc.function as Record<string, unknown>)?.name as string || '';
        if ((tc.function as Record<string, unknown>)?.arguments) {
          tcBuf[targetIdx].args += (tc.function as Record<string, unknown>).arguments as string;
        }
        if (tc.id && !tcBuf[targetIdx].id) tcBuf[targetIdx].id = tc.id as string;
      }
      const usage = evt.usage as Record<string, unknown> | undefined;
      if (usage) recordUsage(usage, apiMode);
    }

    const blocks: ContentBlock[] = [];
    if (contentText) blocks.push({ type: 'text', text: contentText });
    for (const idx of Object.keys(tcBuf).map(Number).sort((a, b) => a - b)) {
      const tc = tcBuf[idx];
      const inps = tryParseToolArgs(tc.args);
      for (let i = 0; i < inps.length; i++) {
        let bid = tc.id || '';
        if (inps.length > 1) bid = bid ? `${bid}_${i}` : `split_${i}`;
        blocks.push({ type: 'tool_use', id: bid, name: tc.name, input: inps[i] });
      }
    }
    return blocks;
  }
}

async function readAllLines(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string[]> {
  const decoder = new TextDecoder();
  let buffer = '';
  const allLines: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      allLines.push(...lines);
    }
    if (buffer) allLines.push(buffer);
  } catch { /* reader closed */ }
  return allLines;
}

// ─── OpenAI JSON parser (non-streaming) ─────────────────────────────────────

export async function* parseOpenAIJson(data: Record<string, unknown>, apiMode: string = 'chat_completions'): AsyncGenerator<string, ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  if (apiMode === 'responses') {
    recordUsage((data.usage as Record<string, unknown>) || {}, apiMode);
    const output = (data.output as Record<string, unknown>[]) || [];
    for (const item of output) {
      if (item.type === 'message') {
        const content = (item.content as Record<string, unknown>[]) || [];
        for (const p of content) {
          if ((p.type === 'output_text' || p.type === 'text') && p.text) {
            blocks.push({ type: 'text', text: p.text as string });
            yield p.text as string;
          }
        }
      } else if (item.type === 'function_call') {
        let args: Record<string, unknown> = {};
        try {
          args = item.arguments ? JSON.parse(item.arguments as string) : {};
        } catch {
          args = { _raw: item.arguments as string || '' };
        }
        blocks.push({
          type: 'tool_use',
          id: (item.call_id as string) || (item.id as string) || '',
          name: (item.name as string) || '',
          input: args,
        });
      }
    }
  } else {
    recordUsage((data.usage as Record<string, unknown>) || {}, apiMode);
    const choices = (data.choices as Record<string, unknown>[]) || [{}];
    const msg = (choices[0].message as Record<string, unknown>) || {};
    const content = (msg.content as string) || '';
    if (content) {
      blocks.push({ type: 'text', text: content });
      yield content;
    }
    for (const tc of (msg.tool_calls as Record<string, unknown>[]) || []) {
      const fn = (tc.function as Record<string, unknown>) || {};
      let args: Record<string, unknown> = {};
      try {
        args = fn.arguments ? JSON.parse(fn.arguments as string) : {};
      } catch {
        args = { _raw: fn.arguments as string || '' };
      }
      blocks.push({
        type: 'tool_use',
        id: (tc.id as string) || '',
        name: (fn.name as string) || '',
        input: args,
      });
    }
  }
  return blocks;
}

// ─── Cache markers for OAI-compatible Claude ─────────────────────────────────

export function stampOAICacheMarkers(messages: Message[], model: string): void {
  const ml = model.toLowerCase();
  if (!['claude', 'anthropic'].some(k => ml.includes(k))) return;

  const userIndices = messages
    .map((m, i) => (m.role === 'user' ? i : -1))
    .filter(i => i >= 0);
  for (const idx of userIndices.slice(-2)) {
    const c = messages[idx].content;
    if (typeof c === 'string') {
      messages[idx] = {
        ...messages[idx],
        content: [{ type: 'text', text: c, cache_control: { type: 'ephemeral' } }],
      };
    } else if (Array.isArray(c) && c.length) {
      const newC = [...c];
      newC[newC.length - 1] = { ...newC[newC.length - 1], cache_control: { type: 'ephemeral' } };
      messages[idx] = { ...messages[idx], content: newC };
    }
  }
}

// ─── Shared OpenAI-compatible streaming ──────────────────────────────────────

function prepareOAITools(tools: ToolSchema[], apiMode: string = 'chat_completions'): ToolSchema[] {
  if (apiMode === 'responses') {
    return tools.map(t => {
      if (t.type === 'function' && t.function) {
        const rt: ToolSchema = { type: 'function' as const, function: { ...t.function } };
        return rt;
      }
      return t;
    });
  }
  return tools;
}

function toResponsesInput(messages: Message[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const pending: string[] = [];

  for (const msg of messages) {
    let role = (msg.role || 'user').toLowerCase();
    if (role === 'tool') {
      const cid = msg.tool_call_id || (pending.shift() || `call_${crypto.randomUUID().slice(0, 8)}`);
      result.push({ type: 'function_call_output', call_id: cid, output: msg.content || '' });
      continue;
    }
    if (!['user', 'assistant', 'system', 'developer'].includes(role)) role = 'user';
    if (role === 'system') role = 'developer';

    const content = msg.content || '';
    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    const parts: Record<string, unknown>[] = [];

    if (typeof content === 'string') {
      if (content) parts.push({ type: textType, text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== 'object' || part === null) continue;
        if (part.type === 'text') {
          const text = part.text || '';
          if (text) parts.push({ type: textType, text });
        } else if (part.type === 'image_url') {
          const url = part.image_url?.url || '';
          if (url && role !== 'assistant') parts.push({ type: 'input_image', image_url: url });
        }
      }
    }
    if (parts.length === 0) parts.push({ type: textType, text: String(content) || '[empty]' });
    result.push({ role, content: parts });

    pending.length = 0;
    for (const tc of (msg.tool_calls || [])) {
      const f = tc.function || { name: '', arguments: '' };
      const cid = tc.id || `call_${crypto.randomUUID().slice(0, 8)}`;
      pending.push(cid);
      result.push({ type: 'function_call', call_id: cid, name: f.name, arguments: f.arguments });
    }
  }
  return result;
}

export async function* openAIStream(
  apiBase: string,
  apiKey: string,
  messages: Message[],
  model: string,
  apiMode: string = 'chat_completions',
  system?: string,
  temperature: number = 0.5,
  maxTokens?: number,
  tools?: ToolSchema[],
  reasoningEffort?: string,
  maxRetries: number = 0,
  connectTimeout: number = 10,
  readTimeout: number = 300,
  proxy: Record<string, string> | null = null,
  stream: boolean = true,
): AsyncGenerator<string, ContentBlock[]> {
  const finalTemp = clampTemperature(model, temperature);

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };

  let url: string;
  let payload: Record<string, unknown>;

  if (apiMode === 'responses') {
    url = autoMakeUrl(apiBase, 'responses');
    payload = {
      model,
      input: toResponsesInput(messages),
      stream,
      prompt_cache_key: RESP_CACHE_KEY,
      instructions: system || 'You are an Omnipotent Executor.',
    };
    if (reasoningEffort) payload.reasoning = { effort: reasoningEffort };
  } else {
    let reqMessages = messages;
    if (system) reqMessages = [{ role: 'system', content: system }, ...reqMessages];
    stampOAICacheMarkers(reqMessages, model);
    url = autoMakeUrl(apiBase, 'chat/completions');
    payload = { model, messages: reqMessages, stream };
    if (stream) payload.stream_options = { include_usage: true };
    if (finalTemp !== 1) payload.temperature = finalTemp;
    if (maxTokens) payload.max_tokens = maxTokens;
    if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
  }
  if (tools) payload.tools = prepareOAITools(tools, apiMode);

  const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

  function getDelay(response: { headers?: Headers } | null, attempt: number): number {
    if (response) {
      try {
        const ra = response.headers?.get('retry-after');
        if (ra) return Math.max(0.5, parseFloat(ra));
      } catch { /* ignore */ }
    }
    return Math.min(30, 1.5 * Math.pow(2, attempt));
  }

  const fetchInit: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let streamed = false;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), (readTimeout || 300) * 1000);

      const resp = await fetch(url, {
        ...fetchInit,
        signal: controller.signal,
        // @ts-ignore - duplex for Node.js fetch
        duplex: 'half',
      });
      clearTimeout(timeoutId);

      if (resp.status >= 400) {
        if (RETRYABLE.has(resp.status) && attempt < maxRetries) {
          const d = getDelay(resp, attempt);
          console.log(`[LLM Retry] HTTP ${resp.status}, retry in ${d.toFixed(1)}s (${attempt + 1}/${maxRetries + 1})`);
          await sleep(d);
          continue;
        }
        let body = '';
        try { body = (await resp.text()).trim().slice(0, 500); } catch { /* */ }
        const err = `!!!Error: HTTP ${resp.status}${body ? `: ${body}` : ''}`;
        yield err;
        return [{ type: 'text', text: err }];
      }

      if (!resp.body) throw new Error('No response body');

      if (stream) {
        const blocks = yield* parseOpenAISSE(resp.body.getReader(), apiMode);
        return blocks;
      } else {
        const json = await resp.json() as Record<string, unknown>;
        const blocks = yield* parseOpenAIJson(json, apiMode);
        return blocks;
      }
    } catch (e) {
      const errName = e instanceof Error ? e.constructor.name : 'UnknownError';
      const isTimeout = errName === 'AbortError' || errName === 'TimeoutError' || errName.includes('Timeout');
      if ((isTimeout || errName === 'TypeError') && attempt < maxRetries && !streamed) {
        const d = getDelay(null, attempt);
        console.log(`[LLM Retry] ${errName}, retry in ${d.toFixed(1)}s (${attempt + 1}/${maxRetries + 1})`);
        await sleep(d);
        continue;
      }
      const err = `!!!Error: ${errName}: ${e instanceof Error ? e.message : String(e)}`;
      yield err;
      return [{ type: 'text', text: err }];
    }
  }
  // Should not reach here
  const err = '!!!Error: Max retries exceeded';
  yield err;
  return [{ type: 'text', text: err }];
}

// ─── Messages: Claude → OpenAI format ───────────────────────────────────────

export function msgsClaude2OAI(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    const role = msg.role || 'user';
    const content = msg.content;
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];

    if (role === 'assistant') {
      const textParts: Record<string, unknown>[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      for (const b of blocks) {
        if (typeof b !== 'object' || b === null) continue;
        if (b.type === 'text' && b.text) {
          textParts.push({ type: 'text', text: b.text });
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id || '',
            type: 'function',
            function: {
              name: b.name || '',
              arguments: JSON.stringify(b.input || {}),
            },
          });
        }
      }
      const m = { role: 'assistant', content: textParts.length > 0 ? [...textParts] : '' } as Message;
      if (toolCalls.length) m.tool_calls = toolCalls as unknown as Message['tool_calls'];
      result.push(m);
    } else if (role === 'user') {
      const textParts: Record<string, unknown>[] = [];
      for (const _b of blocks) {
        const b = _b as unknown as Record<string, unknown>;
        if (typeof b !== 'object' || b === null) continue;
        if (b.type === 'tool_result') {
          if (textParts.length) {
            result.push({ role: 'user', content: [...textParts] } as unknown as Message);
            textParts.length = 0;
          }
          let tr = b.content;
          if (Array.isArray(tr)) {
            tr = (tr as Record<string, unknown>[]).filter(x => typeof x === 'object' && x !== null && x.type === 'text')
              .map(x => (x as { text: string }).text)
              .join('\n');
          }
          result.push({
            role: 'tool',
            tool_call_id: (b.tool_use_id || '') as string,
            content: typeof tr === 'string' ? tr : String(tr),
          });
        } else if (b.type === 'image') {
          const src = ((b as unknown as ContentBlock).source || {}) as Record<string, unknown>;
          if (src.type === 'base64' && src.data) {
            textParts.push({
              type: 'image_url',
              image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` },
            });
          }
        } else if (b.type === 'image_url') {
          textParts.push(b);
        } else if (b.type === 'text' && b.text) {
          textParts.push({ type: 'text', text: b.text });
        }
      }
      if (textParts.length) result.push({ role: 'user', content: [...textParts] } as unknown as Message);
    } else {
      result.push(msg);
    }
  }
  return result;
}

// ─── Base Session ───────────────────────────────────────────────────────────

export class BaseSession {
  apiKey: string;
  apiBase: string;
  model: string;
  contextWin: number;
  history: Message[];
  system: string;
  name: string;
  proxies: Record<string, string> | null;
  maxRetries: number;
  stream: boolean;
  connectTimeout: number;
  readTimeout: number;
  reasoningEffort: string | null;
  thinkingType: string | null;
  thinkingBudgetTokens: number | undefined;
  apiMode: string;
  temperature: number;
  maxTokens: number;

  constructor(cfg: SessionConfig) {
    this.apiKey = cfg.apikey;
    this.apiBase = cfg.apibase.replace(/\/+$/, '');
    this.model = cfg.model || '';
    this.contextWin = cfg.context_win || 24000;
    this.history = [];
    this.system = '';
    this.name = cfg.name || this.model;
    const proxy = cfg.proxy;
    this.proxies = proxy ? { http: proxy, https: proxy } : null;
    this.maxRetries = Math.max(0, parseInt(String(cfg.max_retries || 1)));
    this.stream = cfg.stream !== false;
    const defaultCt = this.stream ? 5 : 10;
    const defaultRt = this.stream ? 30 : 240;
    this.connectTimeout = Math.max(1, parseInt(String(cfg.timeout || defaultCt)));
    this.readTimeout = Math.max(5, parseInt(String(cfg.read_timeout || defaultRt)));

    const reasonEf = cfg.reasoning_effort;
    this.reasoningEffort = reasonEf && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(reasonEf).trim().toLowerCase())
      ? String(reasonEf).trim().toLowerCase() : null;

    const thinkType = cfg.thinking_type;
    this.thinkingType = thinkType && ['adaptive', 'enabled', 'disabled'].includes(String(thinkType).trim().toLowerCase())
      ? String(thinkType).trim().toLowerCase() : null;

    this.thinkingBudgetTokens = cfg.thinking_budget_tokens as number | undefined;

    const mode = String(cfg.api_mode || 'chat_completions').trim().toLowerCase().replace(/-/g, '_');
    this.apiMode = mode === 'responses' || mode === 'response' ? 'responses' : 'chat_completions';
    this.temperature = cfg.temperature !== undefined ? cfg.temperature : 1;
    this.maxTokens = cfg.max_tokens || 8192;
  }

  applyClaudeThinking(payload: Record<string, unknown>): void {
    if (this.thinkingType) {
      const thinking: Record<string, unknown> = { type: this.thinkingType };
      if (this.thinkingType === 'enabled') {
        if (this.thinkingBudgetTokens === undefined) {
          console.log("[WARN] thinking_type='enabled' requires thinking_budget_tokens, ignored.");
        } else {
          thinking.budget_tokens = this.thinkingBudgetTokens;
          payload.thinking = thinking;
        }
      } else {
        payload.thinking = thinking;
      }
    }
    if (this.reasoningEffort) {
      const effortMap: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'max' };
      const effort = effortMap[this.reasoningEffort];
      if (effort) {
        payload.output_config = { effort };
      } else {
        console.log(`[WARN] reasoning_effort ${this.reasoningEffort} is unsupported for Claude output_config.effort, ignored.`);
      }
    }
  }

  async ask(prompt: string, stream: boolean = false): Promise<AsyncGenerator<string, MockResponse> | string> {
    const gen = this._askGen(prompt);
    if (stream) return gen;
    let result = '';
    for await (const chunk of gen) {
      result += chunk;
    }
    return result;
  }

  private async *_askGen(prompt: string): AsyncGenerator<string, MockResponse> {
    this.history.push({ role: 'user', content: [{ type: 'text', text: prompt }] });
    trimMessagesHistory(this.history, this.contextWin);
    const messages = this.makeMessages(this.history);
    let contentBlocks: ContentBlock[] = [];
    let content = '';
    const gen = this.rawAsk(messages);
    let rv = await gen.next();
    while (!rv.done) {
      const chunk = rv.value;
      content += chunk;
      yield chunk;
      rv = await gen.next();
    }
    contentBlocks = rv.value;

    for (const block of contentBlocks) {
      if (block.type === 'tool_use') {
        yield `<tool_use>${JSON.stringify({ name: block.name, arguments: block.input })}</tool_use>`;
      }
    }
    if (!content.startsWith('Error:')) {
      this.history.push({ role: 'assistant', content: [{ type: 'text', text: content }] });
    }
    return new MockResponse('', content, [], content);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *rawAsk(_messages: ContentBlock[] | Message[]): AsyncGenerator<string, ContentBlock[]> {
    // Override in subclasses
    return [];
  }

  makeMessages(rawList: Message[]): ContentBlock[] | Message[] {
    return rawList;
  }
}

// ─── Claude Session ─────────────────────────────────────────────────────────

export class ClaudeSession extends BaseSession {
  async *rawAsk(messages: ContentBlock[] | Message[]): AsyncGenerator<string, ContentBlock[]> {
    const typedMessages = messages as Message[];
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    };

    const payload: Record<string, unknown> = {
      model: this.model,
      messages: typedMessages,
      max_tokens: this.maxTokens,
      stream: true,
    };
    if (this.temperature !== 1) {
      payload.temperature = clampTemperature(this.model, this.temperature);
    }
    this.applyClaudeThinking(payload);
    if (this.system) {
      payload.system = [{ type: 'text', text: this.system, cache_control: { type: 'persistent' as const } }];
    }

    try {
      const resp = await fetch(autoMakeUrl(this.apiBase, 'messages'), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (resp.status !== 200) {
        const body = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} ${body.slice(0, 500)}`);
      }
      const blocks = yield* parseClaudeSSE(resp.body!.getReader());
      return blocks;
    } catch (e) {
      const err = `Error: ${e instanceof Error ? e.message : String(e)}`;
      yield err;
      return [{ type: 'text', text: err }];
    }
  }

  override makeMessages(rawList: Message[]): Message[] {
    const msgs = rawList.map(m => ({
      role: m.role,
      content: Array.isArray(m.content) ? [...m.content] : [m.content],
    })) as Message[];

    const userIndices = msgs
      .map((m, i) => (m.role === 'user' ? i : -1))
      .filter(i => i >= 0);

    for (const idx of userIndices.slice(-2)) {
      const c = msgs[idx].content as ContentBlock[];
      if (Array.isArray(c) && c.length) {
        c[c.length - 1] = { ...c[c.length - 1], cache_control: { type: 'ephemeral' } };
      }
    }
    return msgs;
  }
}

// ─── LLM Session (OpenAI-compatible, non-native) ────────────────────────────

export class LLMSession extends BaseSession {
  async *rawAsk(messages: ContentBlock[] | Message[]): AsyncGenerator<string, ContentBlock[]> {
    const typedMessages = messages as Message[];
    return yield* openAIStream(
      this.apiBase, this.apiKey, typedMessages, this.model, this.apiMode,
      undefined, this.temperature, this.maxTokens,
      undefined, this.reasoningEffort || undefined,
      this.maxRetries, this.connectTimeout, this.readTimeout,
      this.proxies, this.stream,
    );
  }

  override makeMessages(rawList: Message[]): Message[] {
    return msgsClaude2OAI(rawList);
  }
}

// ─── Fix messages for native sessions ───────────────────────────────────────

export function fixMessages(messages: Message[]): Message[] {
  if (!messages.length) return messages;
  const wrap = (c: unknown): ContentBlock[] =>
    Array.isArray(c) ? c as ContentBlock[] : [{ type: 'text', text: String(c) }];

  const fixed: Message[] = [];
  for (let m of messages) {
    if (fixed.length && m.role === fixed[fixed.length - 1].role) {
      const last = fixed[fixed.length - 1];
      fixed[fixed.length - 1] = {
        ...last,
        content: [...wrap(last.content), { type: 'text', text: '\n' }, ...wrap(m.content)],
      };
      continue;
    }
    if (fixed.length && fixed[fixed.length - 1].role === 'assistant' && m.role === 'user') {
      const uses = (wrap(fixed[fixed.length - 1].content) as ContentBlock[])
        .filter(b => typeof b === 'object' && b !== null && b.type === 'tool_use' && b.id)
        .map(b => b.id!);
      const has = new Set(
        wrap(m.content)
          .filter(b => typeof b === 'object' && b !== null && b.type === 'tool_result' && b.tool_use_id)
          .map(b => b.tool_use_id!)
      );
      const miss = uses.filter(uid => !has.has(uid));
      if (miss.length) {
        m = {
          ...m,
          content: [
            ...miss.map(uid => ({ type: 'tool_result' as const, tool_use_id: uid, content: '(error)' })),
            ...wrap(m.content),
          ],
        };
      }
    }
    fixed.push(m);
  }
  while (fixed.length && fixed[0].role !== 'user') fixed.shift();
  return fixed;
}

// ─── Native Claude Session ──────────────────────────────────────────────────

export class NativeClaudeSession extends BaseSession {
  fakeCcSystemPrompt: boolean;
  userAgent: string;
  sessionId: string;
  accountUuid: string;
  deviceId: string;
  tools: ToolSchema[] | null = null;

  constructor(cfg: SessionConfig) {
    super(cfg);
    this.contextWin = cfg.context_win || 28000;
    this.fakeCcSystemPrompt = cfg.fake_cc_system_prompt || false;
    this.userAgent = cfg.user_agent || 'claude-cli/2.1.113 (external, cli)';
    this.sessionId = crypto.randomUUID();
    this.accountUuid = crypto.randomUUID();
    this.deviceId = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  }

  async *rawAsk(rawMessages: ContentBlock[] | Message[]): AsyncGenerator<string, ContentBlock[]> {
    let messages = fixMessages(rawMessages as Message[]);
    let model = this.model;
    const betaParts = ['claude-code-20250219', 'interleaved-thinking-2025-05-14', 'redact-thinking-2026-02-12', 'prompt-caching-scope-2026-01-05'];
    if (model.toLowerCase().includes('[1m]')) {
      betaParts.splice(1, 0, 'context-1m-2025-08-07');
      model = model.replace(/\[1m\]/gi, '').replace(/\[1M\]/gi, '');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': betaParts.join(','),
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': this.userAgent,
      'x-app': 'cli',
    };

    if (this.apiKey.startsWith('sk-ant-')) {
      headers['x-api-key'] = this.apiKey;
    } else {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }

    const payload: Record<string, unknown> = {
      model,
      messages,
      max_tokens: this.maxTokens,
      stream: this.stream,
    };
    if (this.temperature !== 1) {
      payload.temperature = clampTemperature(this.model, this.temperature);
    }
    this.applyClaudeThinking(payload);
    payload.metadata = {
      user_id: JSON.stringify({
        device_id: this.deviceId,
        account_uuid: this.accountUuid,
        session_id: this.sessionId,
      }),
    };

    if (this.tools) {
      const claudeTools = openAIToolsToClaude(this.tools);
      const tools = claudeTools.map(t => ({ ...t }));
      if (tools.length) tools[tools.length - 1].cache_control = { type: 'ephemeral' };
      payload.tools = tools;
    } else {
      console.log('[ERROR] No tools provided for this session.');
    }

    payload.system = [{ type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.', cache_control: { type: 'ephemeral' } }];
    if (this.system) {
      if (this.fakeCcSystemPrompt) {
        (messages[0].content as ContentBlock[]).unshift({ type: 'text', text: this.system });
      } else {
        payload.system = [{ type: 'text', text: this.system }];
      }
    }

    const userIndices = messages
      .map((m, i) => (m.role === 'user' ? i : -1))
      .filter(i => i >= 0);
    for (const idx of userIndices.slice(-2)) {
      const c = messages[idx].content as ContentBlock[];
      if (Array.isArray(c) && c.length) {
        c[c.length - 1] = { ...c[c.length - 1], cache_control: { type: 'ephemeral' } };
      }
    }

    try {
      const resp = await fetch(autoMakeUrl(this.apiBase, 'messages') + '?beta=true', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (resp.status !== 200) {
        const body = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} ${body.slice(0, 500)}`);
      }
      if (this.stream) {
        const blocks = yield* parseClaudeSSE(resp.body!.getReader());
        return blocks;
      } else {
        const data = await resp.json() as Record<string, unknown>;
        const blocks = (data.content as ContentBlock[]) || [];
        recordUsage((data.usage as Record<string, unknown>) || {}, 'messages');
        for (const b of blocks) {
          if (b.type === 'text') yield b.text || '';
        }
        return blocks;
      }
    } catch (e) {
      const err = `Error: ${e instanceof Error ? e.message : String(e)}`;
      yield err;
      return [{ type: 'text', text: err }];
    }
  }

  // @ts-expect-error ask signature differs from BaseSession
  async ask(msg: Message): Promise<MockResponse> {
    this.history.push(msg);
    trimMessagesHistory(this.history, this.contextWin);
    const messages = this.history.map(m => ({
      role: m.role as string,
      content: Array.isArray(m.content) ? [...m.content as ContentBlock[]] : [m.content],
    })) as Message[];

    let contentBlocks: ContentBlock[] = [];
    const gen = this.rawAsk(messages);
    let rv2 = await gen.next();
    while (!rv2.done) { /* consume */ rv2 = await gen.next(); }
    contentBlocks = rv2.value;

    if (contentBlocks.length && !(contentBlocks.length === 1 && (contentBlocks[0].text || '').startsWith('Error:'))) {
      this.history.push({ role: 'assistant', content: contentBlocks });
    }

    const textParts = contentBlocks
      .filter(b => b.type === 'text')
      .map(b => b.text || '');
    const content = textParts.join('\n').trim();

    let toolCalls = contentBlocks
      .filter(b => b.type === 'tool_use')
      .map(b => new MockToolCall(b.name || '', b.input || {}, b.id || ''));

    if (toolCalls.length === 0) {
      const [parsedTCs, parsedContent] = parseTextToolCalls(content);
      toolCalls = parsedTCs;
      // Use parsed content as the non-tool text
    }

    const thinkingParts = contentBlocks
      .filter(b => b.type === 'thinking')
      .map(b => b.thinking || '');
    let thinking = thinkingParts.join('\n').trim();

    if (!thinking && content) {
      const thinkMatch = content.match(/<think(?:ing)?>(.*?)<\/think(?:ing)?>/s);
      if (thinkMatch) {
        thinking = thinkMatch[1].trim();
      }
    }

    return new MockResponse(thinking, content, toolCalls, JSON.stringify(contentBlocks));
  }
}

// ─── Native OAI Session ─────────────────────────────────────────────────────

export class NativeOAISession extends NativeClaudeSession {
  async *rawAsk(rawMessages: ContentBlock[] | Message[]): AsyncGenerator<string, ContentBlock[]> {
    let messages = fixMessages(rawMessages as Message[]);
    const oaiMessages = msgsClaude2OAI(messages);
    return yield* openAIStream(
      this.apiBase, this.apiKey, oaiMessages, this.model, this.apiMode,
      this.system, this.temperature, this.maxTokens,
      this.tools || undefined, this.reasoningEffort || undefined,
      this.maxRetries, this.connectTimeout, this.readTimeout,
      this.proxies, this.stream,
    );
  }
}

// ─── Tools: OAI → Claude format ─────────────────────────────────────────────

export function openAIToolsToClaude(tools: ToolSchema[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const t of tools) {
    if ('input_schema' in t) {
      result.push({ ...t } as unknown as Record<string, unknown>);
      continue;
    }
    const fn = t.function || t;
    result.push({
      name: (fn as Record<string, unknown>).name,
      description: (fn as Record<string, unknown>).description || '',
      input_schema: (fn as Record<string, unknown>).parameters || { type: 'object', properties: {} },
    });
  }
  return result;
}

// ─── Tool Client (text protocol, non-native) ────────────────────────────────

export class ToolClient {
  backend: BaseSession | ClaudeSession | LLMSession;
  autoSaveTokens: boolean;
  lastTools: string = '';
  name: string;
  totalCdTokens: number = 0;

  constructor(backend: BaseSession | ClaudeSession | LLMSession, autoSaveTokens: boolean = true) {
    this.backend = backend;
    this.autoSaveTokens = autoSaveTokens;
    this.name = backend.name;
  }

  async *chat(messages: Message[], tools?: ToolSchema[]): AsyncGenerator<string, MockResponse> {
    const fullPrompt = this.buildProtocolPrompt(messages, tools);
    console.log('Full prompt length:', fullPrompt.length, 'chars');
    writeLLMLog('Prompt', fullPrompt);

    // Langfuse: start LLM generation span
    const model = this.backend.model || 'unknown';
    startLLMGeneration(model, [{ role: 'system', contentLen: fullPrompt.length }]);

    let rawText = '';
    const summaryTag = '[NextWillSummary]';
    const askResult = await this.backend.ask(fullPrompt, true);
    const gen = askResult as AsyncGenerator<string, MockResponse>;

    for await (const chunk of gen) {
      rawText += chunk;
      if (chunk !== summaryTag) yield chunk;
    }

    if (rawText.endsWith(summaryTag)) {
      this.lastTools = '';
      rawText = rawText.slice(0, -summaryTag.length);
    }
    writeLLMLog('Response', rawText);

    // Langfuse: end LLM generation span
    endLLMGeneration(rawText.slice(0, 2000));

    return this.parseMixedResponse(rawText);
  }

  private estimateContentLen(content: unknown): number {
    if (typeof content === 'string') return content.length;
    if (Array.isArray(content)) {
      let total = 0;
      for (const part of content) {
        if (typeof part !== 'object' || part === null) continue;
        if ((part as Record<string, unknown>).type === 'text') {
          total += ((part as Record<string, unknown>).text as string)?.length || 0;
        } else if ((part as Record<string, unknown>).type === 'image_url') {
          total += 1000;
        }
      }
      return total;
    }
    return String(content).length;
  }

  private prepareToolInstruction(tools?: ToolSchema[]): string {
    let toolInstruction = '';
    if (!tools) return toolInstruction;

    const toolsJson = JSON.stringify(tools);
    const isEn = (process.env.GA_LANG || 'en') === 'en';

    if (isEn) {
      toolInstruction = `
### Interaction Protocol (must follow strictly, always in effect)
Follow these steps to think and act:
1. **Think**: Analyze the current situation and strategy inside \`<thinking>\` tags.
2. **Summarize**: Output a minimal one-line (<30 words) physical snapshot in \`<summary>\`: new info from last tool result + current tool call intent. This goes into long-term working memory. Must contain real information, no filler.
3. **Act**: If you need to call tools, output one or more **<tool_use> blocks** after your reply, then stop.
`;
    } else {
      toolInstruction = `
### 交互协议 (必须严格遵守，持续有效)
请按照以下步骤思考并行动：
1. **思考**: 在 \`<thinking>\` 标签中先进行思考，分析现状和策略。
2. **总结**: 在 \`<summary>\` 中输出*极为简短*的高度概括的单行（<30字）物理快照，包括上次工具调用结果产生的新信息+本次工具调用意图。此内容将进入长期工作记忆，记录关键信息，严禁输出无实际信息增量的描述。
3. **行动**: 如需调用工具，请在回复正文之后输出一个（或多个）**<tool_use>块**，然后结束。
`;
    }
    toolInstruction += `\nFormat: \`\`\`<tool_use>{"name": "tool_name", "arguments": {...}}</tool_use>\`\`\`\n\n### Tools (mounted, always in effect):\n${toolsJson}\n`;

    if (this.autoSaveTokens && this.lastTools === toolsJson) {
      toolInstruction = isEn
        ? '\n### Tools: still active, **ready to call**. Protocol unchanged.\n'
        : '\n### 工具库状态：持续有效（code_run/file_read等），**可正常调用**。调用协议沿用。\n';
    } else {
      this.totalCdTokens = 0;
    }
    this.lastTools = toolsJson;
    return toolInstruction;
  }

  buildProtocolPrompt(messages: Message[], tools?: ToolSchema[]): string {
    const systemContent = messages.find(m => m.role.toLowerCase() === 'system')?.content || '';
    const historyMsgs = messages.filter(m => m.role.toLowerCase() !== 'system');
    const toolInstruction = this.prepareToolInstruction(tools);

    let system = '';
    let user = '';
    if (systemContent) system += `${systemContent}\n`;
    system += toolInstruction;

    for (const m of historyMsgs) {
      const role = m.role === 'user' ? 'USER' : 'ASSISTANT';
      user += `=== ${role} ===\n`;
      for (const tr of (m.tool_results || [])) {
        user += `<tool_result>${tr.content}</tool_result>\n`;
      }
      user += String(m.content) + '\n';
      this.totalCdTokens += this.estimateContentLen(user);
    }

    if (this.totalCdTokens > 9000) this.lastTools = '';
    user += '=== ASSISTANT ===\n';
    return system + user;
  }

  parseMixedResponse(text: string): MockResponse {
    let remainingText = text;
    let thinking = '';

    const thinkPattern = /<think(?:ing)?>(.*?)<\/think(?:ing)?>/s;
    const thinkMatch = text.match(thinkPattern);
    if (thinkMatch) {
      thinking = thinkMatch[1].trim();
      remainingText = remainingText.replace(thinkPattern, '');
    }

    const toolCalls: MockToolCall[] = [];
    const jsonStrs: string[] = [];
    const errors: Record<string, string>[] = [];

    const toolPattern = /<(?:tool_use|tool_call)>((?:(?!<(?:tool_use|tool_call)>).){15,}?)<\/(?:tool_use|tool_call)>/gs;
    const toolAll = [...remainingText.matchAll(toolPattern)].map(m => m[1].trim());

    if (toolAll.length > 0) {
      const valid = toolAll.filter(s => s.startsWith('{') && s.endsWith('}'));
      jsonStrs.push(...valid);
      remainingText = remainingText.replace(toolPattern, '');
    } else if (remainingText.includes('<tool_use>')) {
      const weakToolStr = remainingText.split('<tool_use>').pop()?.trim().replace(/^[<>]+|[<>]+$/g, '') || '';
      let jsonStr = weakToolStr.endsWith('}') ? weakToolStr : '';
      if (!jsonStr && weakToolStr.includes('```') && weakToolStr.split('```')[0].trim().endsWith('}')) {
        jsonStr = weakToolStr.split('```')[0].trim();
      }
      if (jsonStr) {
        jsonStrs.push(jsonStr);
      }
      remainingText = remainingText.replace(`<tool_use>${weakToolStr}`, '');
    } else if (remainingText.includes('"name":') && remainingText.includes('"arguments":')) {
      const jsonMatch = remainingText.match(/\{.*"name":.*\}/s);
      if (jsonMatch) {
        const jsonStr = jsonMatch[0].trim();
        jsonStrs.push(jsonStr);
        remainingText = remainingText.replace(jsonStr, '').trim();
      }
    }

    for (const jsonStr of jsonStrs) {
      try {
        const data = tryparse(jsonStr) as Record<string, unknown>;
        const funcName = data.name || data.function || data.tool;
        let args = data.arguments || data.args || data.params || data.parameters;
        if (args === undefined) args = data;
        if (funcName) {
          toolCalls.push(new MockToolCall(funcName as string, args as Record<string, unknown>));
        }
      } catch (e) {
        errors.push({ err: `[Warn] Failed to parse tool_use JSON: ${jsonStr}`, bad_json: `Failed to parse tool_use JSON: ${jsonStr.slice(0, 200)}` });
        this.lastTools = '';
      }
    }

    if (toolCalls.length === 0) {
      for (const e of errors) {
        console.log(e.err);
        if (e.bad_json) toolCalls.push(new MockToolCall('bad_json', { msg: e.bad_json }));
      }
    }

    return new MockResponse(thinking, remainingText.trim(), toolCalls, text);
  }
}

// ─── Parse text tool calls ──────────────────────────────────────────────────

export function parseTextToolCalls(content: string): [MockToolCall[], string] {
  const tcs: MockToolCall[] = [];

  // Try JSON array: [{"type":"tool_use", "name":..., "input":...}]
  const jpPrefixes = ['[{"type":"tool_use"', '[{"type": "tool_use"'];
  const jp = jpPrefixes.find(p => content.includes(p));
  if (jp && content.endsWith('}]')) {
    try {
      const idx = content.indexOf(jp);
      const raw = JSON.parse(content.slice(idx)) as Record<string, unknown>[];
      for (const b of raw) {
        if (b.type === 'tool_use') {
          tcs.push(new MockToolCall(b.name as string, (b.input as Record<string, unknown>) || {}, b.id as string || ''));
        }
      }
      return [tcs, content.slice(0, idx).trim()];
    } catch { /* fallthrough */ }
  }

  // Try XML tags: <tool_call>/<tool_use>{"name":..., "arguments":...}</tag>
  const xp = /<(?:tool_use|tool_call)>((?:(?!<(?:tool_use|tool_call)>).){15,}?)<\/(?:tool_use|tool_call)>/gs;
  for (const match of content.matchAll(xp)) {
    try {
      const d = tryparse(match[1].trim()) as Record<string, unknown>;
      const name = d.name;
      const args = d.arguments || d.args || d.input || {};
      if (name) tcs.push(new MockToolCall(name as string, args as Record<string, unknown>));
    } catch { /* skip */ }
  }
  if (tcs.length) {
    content = content.replace(xp, '').trim();
  }
  return [tcs, content];
}

// ─── Write LLM log ──────────────────────────────────────────────────────────

export function writeLLMLog(label: string, content: string): void {
  const logDir = resolve(scriptDir, 'temp/model_responses');
  mkdirSync(logDir, { recursive: true });
  const logPath = resolve(logDir, `model_responses_${process.pid}.txt`);
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  try {
    appendFileSync(logPath, `=== ${label} === ${ts}\n${content}\n\n`, 'utf-8');
  } catch { /* ignore log write errors */ }
}

// ─── tryparse: robust JSON parsing ──────────────────────────────────────────

export function tryparse(jsonStr: string): unknown {
  try { return JSON.parse(jsonStr); } catch { /* */ }
  jsonStr = jsonStr.trim().replace(/^`+|`+$/g, '').replace(/^json\n/, '').trim();
  try { return JSON.parse(jsonStr); } catch { /* */ }
  try { return JSON.parse(jsonStr.slice(0, -1)); } catch { /* */ }
  if (jsonStr.includes('}')) {
    jsonStr = jsonStr.slice(0, jsonStr.lastIndexOf('}') + 1);
  }
  return JSON.parse(jsonStr);
}

// ─── Mixin Session ──────────────────────────────────────────────────────────

export class MixinSession {
  private retries: number;
  private baseDelay: number;
  private springSec: number;
  sessions: (BaseSession | ClaudeSession | LLMSession | NativeClaudeSession | NativeOAISession | MixinSession)[];
  private nameVal: string;
  private origRawAsks: ((...args: unknown[]) => AsyncGenerator<string, ContentBlock[]>)[] = [];
  private curIdx: number = 0;
  private switchedAt: number = 0;

  constructor(allSessions: (ToolClient | NativeToolClient | { backend: BaseSession | ClaudeSession | LLMSession | NativeClaudeSession | NativeOAISession | MixinSession })[] , cfg: MixinConfig) {
    this.retries = cfg.max_retries || 3;
    this.baseDelay = cfg.base_delay || 1.5;
    this.springSec = cfg.spring_back || 300;

    const llmNos = cfg.llm_nos || [];
    this.sessions = llmNos.map(idxOrName => {
      if (typeof idxOrName === 'number') {
        return allSessions[idxOrName].backend!;
      }
      return allSessions.find(s => 'backend' in s && s.backend.name === idxOrName)!.backend!;
    });

    const isNative = (s: BaseSession | ClaudeSession | LLMSession | NativeClaudeSession | NativeOAISession | MixinSession) => s.constructor.name.includes('Native');
    const groups = new Set(this.sessions.map(s => isNative(s)));
    if (groups.size !== 1) {
      throw new Error(`MixinSession: sessions must be in same group (Native or non-Native), got ${this.sessions.map(s => s.constructor.name)}`);
    }
    this.nameVal = this.sessions.map(s => s.name).join('|');

    // Store original rawAsk methods
    this.origRawAsks = this.sessions.map(s => s.rawAsk.bind(s) as (...args: unknown[]) => AsyncGenerator<string, ContentBlock[]>);
    // Copy first session
    const firstCopy = Object.create(Object.getPrototypeOf(this.sessions[0]));
    Object.assign(firstCopy, this.sessions[0]);
    // Replace first session's rawAsk with mixin fallback
    firstCopy.rawAsk = this.mixinRawAsk.bind(this);
    this.sessions[0] = firstCopy;
  }

  get primary(): BaseSession | ClaudeSession | LLMSession | NativeClaudeSession | NativeOAISession | MixinSession { return this.sessions[0]; }

  private pick(): number {
    if (this.curIdx && Date.now() / 1000 - this.switchedAt > this.springSec) {
      this.curIdx = 0;
    }
    return this.curIdx;
  }

  private async *mixinRawAsk(this: MixinSession, ...args: unknown[]): AsyncGenerator<string, ContentBlock[]> {
    const base = this.pick();
    const n = this.sessions.length;
    const testError = (x: string) => x.startsWith('Error:') || x.startsWith('[Error:');

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const idx = (base + attempt) % n;
      const gen = this.origRawAsks[idx].apply(this.sessions[idx], args);
      console.log(`[MixinSession] Using session (${this.sessions[idx].name})`);

      let lastChunk = '';
      let returnVal: ContentBlock[] = [];
      let yielded = false;

      try {
        let rv3 = await gen.next();
        while (!rv3.done) {
          const chunk = rv3.value;
          lastChunk = chunk;
          if (!yielded && testError(chunk)) {
            rv3 = await gen.next();
            continue;
          }
          yield chunk;
          yielded = true;
          rv3 = await gen.next();
        }
        returnVal = rv3.value;
      } catch (e) {
        lastChunk = `Error: ${e}`;
      }

      const isErr = testError(lastChunk);
      if (!isErr) {
        if (attempt > 0) {
          this.curIdx = idx;
          this.switchedAt = Date.now() / 1000;
        }
        return returnVal;
      }

      if (attempt >= this.retries) {
        yield lastChunk;
        return returnVal;
      }

      const nxt = (base + attempt + 1) % n;
      if (nxt === base) {
        const rnd = Math.floor((attempt + 1) / n);
        const delay = Math.min(30, this.baseDelay * Math.pow(1.5, rnd));
        console.log(`[MixinSession] ${lastChunk.slice(0, 80)}, round ${rnd} exhausted, retry in ${delay.toFixed(1)}s`);
        await sleep(delay);
      } else {
        console.log(`[MixinSession] ${lastChunk.slice(0, 80)}, retry ${attempt + 1}/${this.retries} (s${idx}→s${nxt})`);
      }
    }

    return [];
  }

  // Proxy property access to primary session
  get model() { return (this.sessions[0] as SessionConfig & BaseSession).model; }
  get name() { return this.nameVal; }
  get system() { return this.sessions[0].system; }
  set system(v: string) {
    for (const s of this.sessions) s.system = v;
  }
  get tools() { return (this.sessions[0] as NativeClaudeSession).tools; }
  set tools(v: ToolSchema[] | null) {
    for (const s of this.sessions) {
      if (s instanceof NativeClaudeSession) {
        (s as NativeClaudeSession).tools = v;
      }
    }
  }
  get history() { return this.sessions[0].history; }
  set history(v: Message[]) {
    for (const s of this.sessions) s.history = v;
  }
  get temperature() { return this.sessions[0].temperature; }
  set temperature(v: number) {
    for (const s of this.sessions) s.temperature = v;
  }
  get maxTokens() { return this.sessions[0].maxTokens; }
  set maxTokens(v: number) {
    for (const s of this.sessions) s.maxTokens = v;
  }
  get reasoningEffort() { return this.sessions[0].reasoningEffort; }
  set reasoningEffort(v: string | null) {
    for (const s of this.sessions) s.reasoningEffort = v;
  }
  get thinkingType() { return this.sessions[0].thinkingType; }
  set thinkingType(v: string | null) {
    for (const s of this.sessions) s.thinkingType = v;
  }
  get thinkingBudgetTokens() { return this.sessions[0].thinkingBudgetTokens; }
  set thinkingBudgetTokens(v: number | undefined) {
    for (const s of this.sessions) s.thinkingBudgetTokens = v;
  }
  get extraSysPrompt() { return (this.sessions[0] as unknown as Record<string, string>).extra_sys_prompt; }
  set extraSysPrompt(v: string) {
    (this.sessions[0] as unknown as Record<string, string>).extra_sys_prompt = v;
  }
  rawAsk = this.mixinRawAsk;
}

// ─── Native Tool Client ─────────────────────────────────────────────────────

const THINKING_PROMPT_ZH = `
### 行动规范（持续有效）
每次回复请先在回复文字中包含一个<summary></summary> 中输出极简单行（<30字）物理快照：上次结果新信息+本次意图。此内容进入长期工作记忆。
\n**若用户需求未完成，必须进行工具调用！**
`.trim();

const THINKING_PROMPT_EN = `
### Action Protocol (always in effect)
The reply body should first include a minimal one-line (<30 words) physical snapshot in <summary></summary>: new info from last result + current intent. This goes into long-term working memory.
\n**If the user's request is not yet complete, tool calls are required!**
`.trim();

export function getThinkingPrompt(): string {
  return (process.env.GA_LANG || 'en') === 'en' ? THINKING_PROMPT_EN : THINKING_PROMPT_ZH;
}

export class NativeToolClient {
  backend: NativeClaudeSession | NativeOAISession;
  name: string;
  private pendingToolIds: string[] = [];

  constructor(backend: NativeClaudeSession | NativeOAISession) {
    this.backend = backend;
    this.backend.system = getThinkingPrompt();
    this.name = backend.name;
  }

  setSystem(extraSystem?: string): void {
    const combined = extraSystem ? `${extraSystem}\n\n${getThinkingPrompt()}` : getThinkingPrompt();
    if (combined !== this.backend.system) {
      console.log(`[Debug] Updated system prompt, length ${combined.length} chars.`);
    }
    this.backend.system = combined;
  }

  async *chat(messages: Message[], tools?: ToolSchema[]): AsyncGenerator<string, MockResponse> {
    if (tools) this.backend.tools = tools;

    const combinedContent: ContentBlock[] = [];
    let resp: MockResponse | null = null;
    const toolResults: { tool_use_id: string; content: string }[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        this.setSystem(typeof msg.content === 'string' ? msg.content : '');
        continue;
      }
      const c = msg.content;
      if (typeof c === 'string') {
        combinedContent.push({ type: 'text', text: c });
      } else if (Array.isArray(c)) {
        combinedContent.push(...c);
      }
      if (msg.role === 'user' && msg.tool_results) {
        toolResults.push(...msg.tool_results);
      }
    }

    const trIdSet = new Set<string>();
    const toolResultBlocks: ContentBlock[] = [];

    for (const tr of toolResults) {
      const toolUseId = tr.tool_use_id || '';
      trIdSet.add(toolUseId);
      if (toolUseId) {
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: tr.content || '',
        });
      } else {
        combinedContent.unshift({ type: 'text', text: `<tool_result>${tr.content}</tool_result>` });
      }
    }

    for (const tid of this.pendingToolIds) {
      if (!trIdSet.has(tid)) {
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: tid, content: '' });
      }
    }
    this.pendingToolIds = [];

    const merged: Message = { role: 'user', content: [...toolResultBlocks, ...combinedContent] };
    writeLLMLog('Prompt', JSON.stringify(merged, null, 2));

    // Langfuse: start LLM generation span
    const model = this.backend.model || 'unknown';
    startLLMGeneration(model, [{ role: 'user', contentLen: JSON.stringify(merged).length }]);

    resp = await this.backend.ask(merged);

    if (resp) writeLLMLog('Response', resp.raw);

    // Langfuse: end LLM generation span
    endLLMGeneration(resp?.raw?.slice(0, 2000) || '');

    if (resp?.tool_calls?.length) {
      this.pendingToolIds = resp.tool_calls.map(tc => tc.id);
    }
    return resp;
  }
}

// ─── Sleep helper ───────────────────────────────────────────────────────────

export function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}
