// skills/skill-search.ts
// Environment-aware skill discovery.
// Detects local OS, shell, runtimes, and installed tools,
// then queries the skill-card search API (10.5万+ cards) for matching skills.

import { execSync } from 'child_process';
import { platform, arch, release, cpus, totalmem } from 'os';

// ─── Environment fingerprinter ──────────────────────────────────────────────

export interface EnvFingerprint {
  os: string;
  osVersion: string;
  arch: string;
  shell: string;
  cpuCores: number;
  memoryGB: number;
  runtimes: string[];    // node, python, rust, go, etc.
  packageManagers: string[];
  tools: string[];        // git, docker, kubectl, etc.
  editors: string[];
}

/** Try to run a command and return trimmed stdout, or null on failure. */
function tryCmd(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Check if a command exists (exit code 0). */
function cmdExists(name: string): boolean {
  try {
    execSync(`${process.platform === 'win32' ? 'where' : 'command -v'} ${name}`, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Build a full environment fingerprint from the local machine. */
export function fingerprintEnv(): EnvFingerprint {
  const osName = platform();
  let osVersion = release();
  let shell = process.env['SHELL'] || process.env['COMSPEC'] || 'unknown';

  if (osName === 'darwin') {
    osVersion = tryCmd('sw_vers -productVersion') || osVersion;
  } else if (osName === 'linux') {
    const lsb = tryCmd('lsb_release -ds 2>/dev/null') || tryCmd('cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \'"\'');
    if (lsb) osVersion = lsb;
  } else if (osName === 'win32') {
    osVersion = tryCmd('ver') || osVersion;
    if (!shell || shell === 'unknown') {
      const ps = tryCmd('powershell -Command "(Get-Host).Name"');
      if (ps) shell = ps;
    }
  }

  // Detect runtimes
  const runtimes: string[] = [];
  if (cmdExists('node')) {
    const ver = tryCmd('node -v');
    runtimes.push(ver ? `node ${ver}` : 'node');
  }
  if (cmdExists('python3') || cmdExists('python')) {
    const py = cmdExists('python3') ? 'python3' : 'python';
    const ver = tryCmd(`${py} --version`);
    runtimes.push(ver ? ver.replace('Python ', 'python ') : 'python');
  }
  if (cmdExists('go')) {
    const ver = tryCmd('go version');
    runtimes.push(ver ? ver.split(' ')[2] : 'go');
  }
  if (cmdExists('rustc')) {
    const ver = tryCmd('rustc --version');
    runtimes.push(ver ? ver.split(' ')[1] : 'rust');
  }
  if (cmdExists('java')) {
    const ver = tryCmd('java -version 2>&1 | head -1');
    runtimes.push(ver ? ver : 'java');
  }
  if (cmdExists('dotnet')) {
    const ver = tryCmd('dotnet --version');
    runtimes.push(ver ? `dotnet ${ver}` : 'dotnet');
  }

  // Detect package managers
  const packageManagers: string[] = [];
  if (cmdExists('npm')) packageManagers.push('npm');
  if (cmdExists('pnpm')) packageManagers.push('pnpm');
  if (cmdExists('yarn')) packageManagers.push('yarn');
  if (cmdExists('pip3') || cmdExists('pip')) packageManagers.push('pip');
  if (cmdExists('cargo')) packageManagers.push('cargo');
  if (cmdExists('go')) packageManagers.push('go modules');

  // Detect common tools
  const tools: string[] = [];
  if (cmdExists('git')) {
    const ver = tryCmd('git --version');
    tools.push(ver || 'git');
  }
  if (cmdExists('docker')) {
    const ver = tryCmd('docker --version');
    tools.push(ver || 'docker');
  }
  if (cmdExists('kubectl')) {
    const ver = tryCmd('kubectl version --client --short 2>/dev/null');
    tools.push(ver || 'kubectl');
  }
  if (cmdExists('helm')) tools.push('helm');
  if (cmdExists('terraform')) tools.push('terraform');
  if (cmdExists('aws')) tools.push('aws-cli');
  if (cmdExists('gcloud')) tools.push('gcloud');
  if (cmdExists('az')) tools.push('azure-cli');

  // Detect editors / IDEs
  const editors: string[] = [];
  if (cmdExists('code')) editors.push('vscode');
  if (cmdExists('nvim') || cmdExists('vim')) editors.push('vim/neovim');
  if (cmdExists('emacs')) editors.push('emacs');

  return {
    os: osName,
    osVersion,
    arch: arch(),
    shell,
    cpuCores: cpus().length,
    memoryGB: Math.round(totalmem() / (1024 ** 3)),
    runtimes,
    packageManagers,
    tools,
    editors,
  };
}

// ─── Skill search client ────────────────────────────────────────────────────

export interface SkillCard {
  name: string;
  description: string;
  category: string;
  keywords: string[];
  relevance: number;
  source_url?: string;
}

export interface SearchOptions {
  maxResults?: number;
  categories?: string[];
  envFingerprint?: EnvFingerprint;
}

const DEFAULT_API = 'http://www.fudankw.cn:58787';

/**
 * Search the skill database for matching skills.
 * Automatically includes environment context to improve relevance.
 */
export async function searchSkills(
  query: string,
  options: SearchOptions = {},
): Promise<SkillCard[]> {
  const apiUrl = process.env['SKILL_SEARCH_API'] || DEFAULT_API;
  const maxResults = options.maxResults || 10;

  const fp = options.envFingerprint || fingerprintEnv();

  const body = {
    query,
    max_results: maxResults,
    categories: options.categories || [],
    env: {
      os: fp.os,
      arch: fp.arch,
      shell: fp.shell,
      runtimes: fp.runtimes,
      tools: fp.tools,
    },
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(`${apiUrl}/api/skills/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      console.error(`[SkillSearch] API returned ${resp.status}: ${resp.statusText}`);
      return [];
    }

    const data = await resp.json() as { results?: SkillCard[]; skills?: SkillCard[]; data?: SkillCard[] };
    const results = data.results || data.skills || data.data || [];
    return results.slice(0, maxResults);
  } catch (err) {
    console.error(`[SkillSearch] Search failed: ${err}`);
    return [];
  }
}

/**
 * Search with auto-detected environment context. Convenience wrapper.
 */
export async function search(query: string, maxResults: number = 10): Promise<SkillCard[]> {
  return searchSkills(query, { maxResults, envFingerprint: fingerprintEnv() });
}

/**
 * Get trending / popular skills.
 */
export async function getTrendingSkills(maxResults: number = 10): Promise<SkillCard[]> {
  return searchSkills('', { maxResults });
}

/**
 * Format a single skill card for display.
 */
export function formatSkillCard(skill: SkillCard): string {
  const parts: string[] = [
    `🔧 ${skill.name}`,
    `   Category: ${skill.category}`,
    `   Relevance: ${(skill.relevance * 100).toFixed(0)}%`,
  ];
  if (skill.description) {
    parts.push(`   ${skill.description.slice(0, 120)}`);
  }
  if (skill.keywords?.length) {
    parts.push(`   Keywords: ${skill.keywords.join(', ')}`);
  }
  if (skill.source_url) {
    parts.push(`   Source: ${skill.source_url}`);
  }
  return parts.join('\n');
}

/**
 * Batch format multiple skill cards.
 */
export function formatSkillResults(skills: SkillCard[]): string {
  if (!skills.length) return 'No matching skills found.';
  return skills.map(formatSkillCard).join('\n\n');
}
