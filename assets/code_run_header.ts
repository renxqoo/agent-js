// code_run_header.ts
// Ported from code_run_header.py - injected as a header into code-runner .js/.ts temp files
// before execution via tsx/node. Provides subprocess convenience wrappers and error hints.

export const CODE_RUN_HEADER = `// --- Agent Code Runner Header (auto-injected) ---
const __child_process = require('child_process');
const __path = require('path');
const __fs = require('fs');
const __os = require('os');
const __util = require('util');

// Add memory directory to module search paths (port of sys.path.append)
const __memoryDir = __path.join(__path.dirname(__filename || '.'), '..', 'memory');
if (typeof require.main !== 'undefined' && require.main.paths) {
  if (!require.main.paths.includes(__memoryDir)) {
    require.main.paths.unshift(__memoryDir);
  }
}

// Monkey-patch child_process.spawnSync / execSync with auto-decode convenience
// Port of Python's subprocess.run wrapper (_run)
const __origExecSync = __child_process.execSync;
const __origSpawnSync = __child_process.spawnSync;

function __decodeBuf(b) {
  // Port of Python's _d(b) helper
  if (!b) return '';
  if (typeof b === 'string') return b;
  try { return b.toString('utf8'); } catch (_) {}
  try { return b.toString('latin1'); } catch (_) {}
  return String(b);
}

// Convenience wrapper: auto-decodes stdout/stderr, handles text mode
function run(cmd, opts) {
  opts = opts || {};
  const textMode = opts.text || opts.encoding !== undefined;
  delete opts.text;
  if (textMode && typeof opts.input === 'string') {
    opts.input = Buffer.from(opts.input);
  }
  // Use execSync for string-return, spawnSync for more control
  if (typeof cmd === 'string' && !opts.shell) {
    opts.shell = true;
  }
  let result;
  try {
    result = __origSpawnSync(cmd, opts.args || [], {
      ...opts,
      encoding: opts.encoding || 'buffer'
    });
  } catch (e) {
    result = e;
  }
  if (textMode) {
    if (result.stdout) result.stdout = __decodeBuf(result.stdout);
    if (result.stderr) result.stderr = __decodeBuf(result.stderr);
  }
  return result;
}
__child_process.run = run;

// Global exception hook: give hints for missing packages
// Port of Python's sys.excepthook override for ImportError / AttributeError
const __origUncaught = process.listeners('uncaughtException').slice();
process.removeAllListeners('uncaughtException');
process.on('uncaughtException', (err, origin) => {
  const isImportError = err.code === 'ERR_MODULE_NOT_FOUND' ||
    err.code === 'MODULE_NOT_FOUND' ||
    (err.message && /Cannot find module/.test(err.message));
  const isAttrError = err instanceof TypeError &&
    (err.message && /is not a function|has no method|undefined is not|Cannot read propert/.test(err.message));

  if (isImportError || isAttrError) {
    for (const l of __origUncaught) { try { l.call(process, err, origin); } catch (_) {} }
    process.stderr.write('\\n[Agent Hint]: NO GUESSING! You MUST probe first. If missing common package, npm install.\\n');
  } else {
    for (const l of __origUncaught) { try { l.call(process, err, origin); } catch (_) {} }
  }
});

// Make commonly used modules available as globals
global.__child_process = __child_process;
global.__path = __path;
global.__fs = __fs;
global.__os = __os;
// --- End Agent Code Runner Header ---
`;

export default CODE_RUN_HEADER;
