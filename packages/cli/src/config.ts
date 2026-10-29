import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BASE_URL } from './version.js';

export type Env = Record<string, string | undefined>;

export interface ConfigFile {
  base_url?: string;
  api_key?: string;
  default_site?: string;
}

export interface Settings {
  baseUrl: string;
  apiKey: string | undefined;
  site: string | undefined;
}

export function configDir(env: Env): string {
  if (env['PAPERBOY_CONFIG_DIR']) return env['PAPERBOY_CONFIG_DIR'];
  if (env['XDG_CONFIG_HOME']) return join(env['XDG_CONFIG_HOME'], 'paperboy');
  return join(env['HOME'] ?? env['USERPROFILE'] ?? homedir(), '.config', 'paperboy');
}

export function configPath(env: Env): string {
  return join(configDir(env), 'config.json');
}

export function readConfig(env: Env): ConfigFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(env), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const raw = parsed as Record<string, unknown>;
    const out: ConfigFile = {};
    if (typeof raw['base_url'] === 'string') out.base_url = raw['base_url'];
    if (typeof raw['api_key'] === 'string') out.api_key = raw['api_key'];
    if (typeof raw['default_site'] === 'string') out.default_site = raw['default_site'];
    return out;
  } catch {
    return {};
  }
}

/** Merge `patch` into the stored config. Directory is 0700 and the file 0600. */
export function updateConfig(env: Env, patch: ConfigFile): string {
  const dir = configDir(env);
  const file = configPath(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Not fatal, for example on filesystems without permissions.
  }
  const next = { ...readConfig(env), ...patch };
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Same as above.
  }
  return file;
}

export interface FlagInputs {
  'base-url'?: string | undefined;
  'api-key'?: string | undefined;
  site?: string | undefined;
}

/** Precedence: flag, then environment, then config file. */
export function resolveSettings(flags: FlagInputs, env: Env, file: ConfigFile): Settings {
  const baseUrl = flags['base-url'] || env['PAPERBOY_BASE_URL'] || file.base_url || DEFAULT_BASE_URL;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: flags['api-key'] || env['PAPERBOY_API_KEY'] || file.api_key || undefined,
    site: flags.site || file.default_site || undefined,
  };
}

export function maskKey(key: string): string {
  return key.slice(0, 12) + '...';
}
