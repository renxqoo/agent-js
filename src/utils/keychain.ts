// utils/keychain.ts
// XOR-encrypted keystore for securely storing API keys and secrets.
// Data is persisted to ~/ga_keychain.enc with a machine-local obfuscation key.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { hostname, homedir } from 'os';
import { resolve } from 'path';

const KEYCHAIN_PATH = resolve(homedir(), 'ga_keychain.enc');
// Machine-local obfuscation key – derived from hostname + fixed salt.
// This is NOT cryptographically secure; it only prevents casual plaintext leaks.
const OBF_KEY = _deriveObfKey();

function _deriveObfKey(): string {
  const h = (() => {
    try { return hostname(); } catch { return 'localhost'; }
  })();
  let hash = 0;
  const seed = `${h}:ga-seed-2024`;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  // Expand to a repeatable 32-char hex key
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return hex.repeat(4);
}

function _xor(data: string, key: string): string {
  let result = '';
  for (let i = 0; i < data.length; i++) {
    result += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return result;
}

// ─── SecretStr – prevents accidental logging / serialization ────────────────

export class SecretStr {
  private _value: string;

  constructor(value: string) {
    this._value = value;
  }

  /** Get the raw secret value. Callers must handle carefully. */
  get value(): string {
    return this._value;
  }

  /** Override JSON serialization to avoid leaking secrets. */
  toJSON(): string {
    return '***SECRET***';
  }

  /** Override console.log display. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'SecretStr(***)';
  }
}

// ─── Keychain store ─────────────────────────────────────────────────────────

interface KeychainData {
  [name: string]: string; // name → encrypted value
}

function _load(): KeychainData {
  try {
    if (!existsSync(KEYCHAIN_PATH)) return {};
    const raw = readFileSync(KEYCHAIN_PATH, 'utf-8');
    const decrypted = _xor(Buffer.from(raw, 'base64').toString('utf-8'), OBF_KEY);
    return JSON.parse(decrypted);
  } catch {
    return {};
  }
}

function _save(data: KeychainData): void {
  const json = JSON.stringify(data);
  const encrypted = _xor(json, OBF_KEY);
  writeFileSync(KEYCHAIN_PATH, Buffer.from(encrypted, 'utf-8').toString('base64'), 'utf-8');
}

// ─── Public singleton API ───────────────────────────────────────────────────

let _store: KeychainData | null = null;

function _getStore(): KeychainData {
  if (!_store) _store = _load();
  return _store;
}

export const keys = {
  /** Store a secret under the given name. */
  set(name: string, value: string): void {
    _getStore()[name] = value;
    _save(_getStore());
  },

  /** Retrieve a secret, wrapped in SecretStr for safety. Returns null if not found. */
  get(name: string): SecretStr | null {
    const val = _getStore()[name];
    return val !== undefined ? new SecretStr(val) : null;
  },

  /** Delete a secret. */
  delete(name: string): boolean {
    const store = _getStore();
    if (name in store) {
      delete store[name];
      _save(store);
      return true;
    }
    return false;
  },

  /** List all stored secret names (not values). */
  list(): string[] {
    return Object.keys(_getStore());
  },

  /** Check if a secret name exists. */
  has(name: string): boolean {
    return name in _getStore();
  },

  /** Clear the in-memory cache (forces reload from disk). */
  reload(): void {
    _store = null;
  },

  /** Path to the encrypted store file. */
  get path(): string {
    return KEYCHAIN_PATH;
  },
};
