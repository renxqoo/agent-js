// StepOutcome: result of a single tool dispatch
export class StepOutcome {
  data: unknown;
  next_prompt: string | null;
  should_exit: boolean;

  constructor(data: unknown, next_prompt: string | null = null, should_exit: boolean = false) {
    this.data = data;
    this.next_prompt = next_prompt;
    this.should_exit = should_exit;
  }
}

// Mock tool call structure used throughout the codebase
export class MockFunction {
  name: string;
  arguments: string;
  constructor(name: string, args: string) {
    this.name = name;
    this.arguments = args;
  }
}

export class MockToolCall {
  function: MockFunction;
  id: string;
  constructor(name: string, args: unknown, id: string = '') {
    const argStr = typeof args === 'string' ? args : JSON.stringify(args);
    this.function = new MockFunction(name, argStr);
    this.id = id;
  }
}

export class MockResponse {
  thinking: string;
  content: string;
  tool_calls: MockToolCall[];
  raw: string;
  stop_reason: string;

  constructor(thinking: string, content: string, tool_calls: MockToolCall[], raw: string, stop_reason: string = 'end_turn') {
    this.thinking = thinking;
    this.content = content;
    this.tool_calls = tool_calls;
    this.raw = raw;
    this.stop_reason = tool_calls.length > 0 ? 'tool_use' : stop_reason;
  }
}

// Session configuration from mykey.json
export interface SessionConfig {
  apikey: string;
  apibase: string;
  model: string;
  name?: string;
  proxy?: string;
  context_win?: number;
  max_retries?: number;
  stream?: boolean;
  timeout?: number;
  read_timeout?: number;
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  thinking_type?: string;
  thinking_budget_tokens?: number;
  api_mode?: string;
  fake_cc_system_prompt?: boolean;
  user_agent?: string;
  extra_sys_prompt?: string;
  [key: string]: unknown;
}

// Mixin configuration from mykey.json
export interface MixinConfig {
  max_retries?: number;
  base_delay?: number;
  spring_back?: number;
  llm_nos?: (number | string)[];
}

// Key-value store for loaded configuration
export type MyKeys = Record<string, SessionConfig | MixinConfig>;

// Message types
export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  thinking?: string;
  signature?: string;
  tool_use_id?: string;
  content?: string | ContentBlockText[];
  source?: ImageSource;
  image_url?: ImageUrl;
  cache_control?: { type: string };
}

export interface ContentBlockText {
  type: string;
  text: string;
}

export interface ImageSource {
  type: string;
  media_type: string;
  data: string;
}

export interface ImageUrl {
  url: string;
}

export interface Message {
  role: string;
  content: string | ContentBlock[];
  tool_calls?: ToolCallMsg[];
  tool_results?: ToolResult[];
  tool_call_id?: string;
}

export interface ToolCallMsg {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
}

export interface ToolCallRecord {
  tool_name: string;
  args: Record<string, unknown>;
  id?: string;
}

// Tool schema types
export interface ToolSchema {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// Agent history entry
export interface HistoryEntry {
  timestamp: string;
  summary: string;
}

// Display queue item
export interface DisplayItem {
  next?: string;
  done?: string;
  source?: string;
}

// JSON helper
export function jsonDefault(o: unknown): unknown {
  if (o instanceof Set) return Array.from(o);
  return String(o);
}

export function getPrettyJson(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'script' in (data as object)) {
    const copy = { ...(data as Record<string, unknown>) };
    const script = copy['script'] as string;
    copy['script'] = script.replace(/; /g, ';\n  ');
    return JSON.stringify(copy, null, 2).replace(/\\n/g, '\n');
  }
  return JSON.stringify(data, null, 2).replace(/\\n/g, '\n');
}
