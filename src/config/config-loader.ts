import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { config as dotenvConfig } from 'dotenv';
import type { SessionConfig, MixinConfig, MyKeys } from '../core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptDir = resolve(__dirname, '..', '..');

// Load .env
dotenvConfig();

const GA_LANG = process.env.GA_LANG || 'en';

export function getLang(): string {
  return GA_LANG;
}

export function getScriptDir(): string {
  return scriptDir;
}

let _mykeysCache: MyKeys | null = null;

/**
 * Load configuration from mykey.json (or fallback mykey.js pattern).
 * The Python version first tries to import mykey.py, then falls back to mykey.json.
 * In JS, we load mykey.json directly.
 */
export function loadMyKeys(): MyKeys {
  if (_mykeysCache) return _mykeysCache;

  const jsonPath = resolve(scriptDir, 'mykey.json');
  if (existsSync(jsonPath)) {
    _mykeysCache = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  } else {
    // Try mykey.js (CommonJS module export)
    const jsPath = resolve(scriptDir, 'mykey.js');
    if (existsSync(jsPath)) {
      try {
        // Dynamic ESM import for JS config files
        // Use createRequire fallback
        const require = createRequire(import.meta.url);
        _mykeysCache = require(jsPath);
      } catch {
        throw new Error(
          '[ERROR] mykey.json or mykey.js not found. Please create one from mykey_template.'
        );
      }
    } else {
      throw new Error(
        '[ERROR] mykey.json or mykey.js not found. Please create one from mykey_template.'
      );
    }
  }

  return _mykeysCache as MyKeys;
}

/**
 * Get proxy config from global settings.
 */
export function getProxy(): { http: string; https: string } | null {
  const proxy = process.env.PROXY;
  if (proxy) return { http: proxy, https: proxy };
  const mykeys = loadMyKeys();
  const p = mykeys['proxy'] as unknown;
  if (typeof p === 'string' && p) return { http: p, https: p };
  return null;
}
