import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { smartFormat } from '../../src/tools/code-runner.js';
import {
  fileRead, fileWrite, filePatch, fileDelete,
  fileMove, fileList, fileSize, expandFileRefs,
  clearMemoryAccessLog,
} from '../../src/tools/file-io.js';

let testDir: string;

beforeEach(() => {
  testDir = resolve(tmpdir(), 'ga-tools-test', String(Math.random()).slice(2, 10));
  mkdirSync(testDir, { recursive: true });
  clearMemoryAccessLog();
});

afterEach(() => {
  try { rmSync(resolve(tmpdir(), 'ga-tools-test'), { recursive: true, force: true }); } catch { /* ok */ }
});

const p = (name: string) => resolve(testDir, name);

describe('smartFormat', () => {
  it('returns short strings unchanged', () => {
    expect(smartFormat('hello', 100)).toBe('hello');
  });
  it('truncates a long string keeping middle omitted', () => {
    const result = smartFormat('x'.repeat(300), 100);
    expect(result).toContain(' ... ');
    expect(result.length).toBeLessThan(300);
  });
  it('honors custom maxStrLen and omitStr', () => {
    const result = smartFormat('a'.repeat(200), 50, '~~~');
    expect(result).toContain('~~~');
    expect(result.length).toBe(50 + '~~~'.length);
  });
  it('handles an empty string', () => {
    expect(smartFormat('')).toBe('');
  });
});

describe('expandFileRefs', () => {
  it('replaces a valid {{file:path}} reference with numbered content', () => {
    writeFileSync(p('notes.txt'), 'line one\nline two\nline three');
    const result = expandFileRefs('See: {{file:notes.txt}}', testDir);
    expect(result).toContain('1 | line one');
    expect(result).toContain('3 | line three');
    expect(result).not.toContain('{{file:');
  });
  it('returns an error placeholder for a nonexistent file', () => {
    expect(expandFileRefs('{{file:no_such_file.txt}}', testDir)).toContain('[File not found:');
  });
  it('respects the startLine:endLine range', () => {
    writeFileSync(p('lines.txt'), 'a\nb\nc\nd\ne');
    const result = expandFileRefs('{{file:lines.txt:2:4}}', testDir);
    expect(result).toContain('2 | b');
    expect(result).toContain('4 | d');
    expect(result).not.toContain('1 | a');
    expect(result).not.toContain('5 | e');
  });
});

describe('fileRead', () => {
  it('reads an existing file with numbered lines', () => {
    writeFileSync(p('data.txt'), 'alpha\nbeta\ngamma');
    const res = fileRead(p('data.txt'));
    expect(res.status).toBe('success');
    expect(res.content).toContain('1 | alpha');
    expect(res.lineCount).toBe(3);
  });
  it('returns an error for a nonexistent file', () => {
    expect(fileRead(p('no_file.txt')).status).toBe('error');
  });
  it('lists children when given a directory path', () => {
    mkdirSync(p('mydir'));
    writeFileSync(p('mydir/x.txt'), 'x');
    writeFileSync(p('mydir/y.txt'), 'y');
    const res = fileRead(p('mydir'));
    expect(res.status).toBe('success');
    expect(res.msg).toContain('is a directory');
    expect(res.content).toContain('x.txt');
  });
  it('filters lines by a keyword', () => {
    writeFileSync(p('log.txt'), 'INFO: start\nDEBUG: detail\nINFO: end');
    const res = fileRead(p('log.txt'), { keyword: 'INFO' });
    expect(res.content).toContain('INFO');
    expect(res.content).not.toContain('DEBUG');
  });
  it('filters lines by a regex pattern', () => {
    writeFileSync(p('nums.txt'), 'one\n2\ntwo\n4\nthree');
    const res = fileRead(p('nums.txt'), { regex: '^\\d$' });
    expect(res.content).toContain('2');
    expect(res.content).not.toContain('one');
  });
  it('slices output to a lineRange', () => {
    writeFileSync(p('range.txt'), '1\n2\n3\n4\n5\n6');
    const res = fileRead(p('range.txt'), { lineRange: [2, 4] });
    expect(res.content).not.toContain('1 | 5');
  });
  it('truncates long output via maxChars', () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(p('big.txt'), long);
    const res = fileRead(p('big.txt'), { maxChars: 80 });
    expect(res.status).toBe('success');
    expect(res.content.length).toBeLessThan(long.length);
  });
  it('finds approximate matches with fuzzy (exercises trigramSimilarity)', () => {
    writeFileSync(p('fz.txt'), 'apple pie\nbanana split\ncherry tart\ngrape juice');
    const res = fileRead(p('fz.txt'), { fuzzy: 'aple' });
    expect(res.content).toContain('apple');
  });
});

describe('fileWrite', () => {
  it('creates a brand-new file', () => {
    expect(fileWrite(p('new.txt'), 'hello').status).toBe('success');
    expect(readFileSync(p('new.txt'), 'utf-8')).toBe('hello');
  });
  it('overwrites an existing file', () => {
    writeFileSync(p('overwrite.txt'), 'old content');
    fileWrite(p('overwrite.txt'), 'new content');
    expect(readFileSync(p('overwrite.txt'), 'utf-8')).toBe('new content');
  });
  it('appends content when mode is append', () => {
    writeFileSync(p('append.txt'), 'header\n');
    fileWrite(p('append.txt'), 'appended line\n', 'append');
    expect(readFileSync(p('append.txt'), 'utf-8')).toBe('header\nappended line\n');
  });
  it('creates nested directories automatically', () => {
    fileWrite(p('a/b/c.txt'), 'deep');
    expect(readFileSync(p('a/b/c.txt'), 'utf-8')).toBe('deep');
  });
});

describe('filePatch', () => {
  it('finds old content and replaces it with new content', () => {
    writeFileSync(p('patch.txt'), 'line A\nline B\nline C');
    const res = filePatch(p('patch.txt'), 'line B', 'line B patched');
    expect(res.status).toBe('success');
    expect(readFileSync(p('patch.txt'), 'utf-8')).toContain('line B patched');
  });
  it('returns an error when old content is not found', () => {
    writeFileSync(p('no_match.txt'), 'hello world');
    const res = filePatch(p('no_match.txt'), 'missing text', 'replacement');
    expect(res.status).toBe('error');
    expect(res.msg).toContain('Could not find');
  });
});

describe('fileDelete', () => {
  it('deletes an existing file', () => {
    writeFileSync(p('to_delete.txt'), 'bye');
    fileDelete(p('to_delete.txt'));
    expect(existsSync(p('to_delete.txt'))).toBe(false);
  });
  it('succeeds silently for a nonexistent file', () => {
    const res = fileDelete(p('no_such.txt'));
    expect(res.status).toBe('success');
    expect(res.msg).toContain('does not exist');
  });
});

describe('fileMove', () => {
  it('moves a file from src to dst', () => {
    writeFileSync(p('src.txt'), 'move me');
    fileMove(p('src.txt'), p('dst.txt'));
    expect(existsSync(p('src.txt'))).toBe(false);
    expect(readFileSync(p('dst.txt'), 'utf-8')).toBe('move me');
  });
});

describe('fileList', () => {
  it('lists all entries in a directory', () => {
    writeFileSync(p('a.txt'), 'a');
    writeFileSync(p('b.md'), 'b');
    const res = fileList(testDir);
    expect(res.status).toBe('success');
    expect(res.entries).toContain('a.txt');
    expect(res.entries).toContain('b.md');
  });
  it('filters entries by extension', () => {
    writeFileSync(p('a.txt'), 'a');
    writeFileSync(p('b.md'), 'b');
    writeFileSync(p('c.txt'), 'c');
    const res = fileList(testDir, { extensions: ['.txt'] });
    expect(res.entries).toHaveLength(2);
    expect(res.entries.every(e => e.endsWith('.txt'))).toBe(true);
  });
  it('returns an error for a nonexistent directory', () => {
    expect(fileList(p('no_dir')).status).toBe('error');
  });
});

describe('fileSize', () => {
  it('returns the correct byte count for a file', () => {
    writeFileSync(p('size.txt'), '1234567890');
    const res = fileSize(p('size.txt'));
    expect(res.status).toBe('success');
    expect(res.size).toBe(10);
  });
  it('returns the recursive byte total for a directory', () => {
    writeFileSync(p('f1.txt'), 'hello');
    mkdirSync(p('sub'));
    writeFileSync(p('sub/f2.txt'), 'world');
    const res = fileSize(testDir);
    expect(res.status).toBe('success');
    expect(res.size).toBe(10);
  });
  it('returns an error for a nonexistent path', () => {
    const res = fileSize(p('nope'));
    expect(res.status).toBe('error');
    expect(res.size).toBe(0);
  });
});
