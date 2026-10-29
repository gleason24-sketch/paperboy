import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url).pathname;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (!/package-lock\.json$/.test(name)) out.push(full);
  }
  return out;
}

// Patterns are assembled from pieces so this file never contains the forbidden text itself.
const dashes = new RegExp('[\\u' + '2014\\u' + '2013]');
const banned = new RegExp(['ki' + 'mi', 'moon' + 'shot'].join('|'), 'i');

describe('source hygiene', () => {
  const all = files(root);

  it('scans the package sources', () => {
    const rel = all.map((f) => relative(root, f));
    expect(rel).toContain('README.md');
    expect(rel).toContain('src/main.ts');
    expect(rel).toContain('package.json');
  });

  it('has no em dash or en dash characters', () => {
    const hits = all.filter((f) => dashes.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));
    expect(hits).toEqual([]);
  });

  it('has no references to banned vendor names', () => {
    const hits = all.filter((f) => banned.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));
    expect(hits).toEqual([]);
  });

  it('is AGPL-3.0 licensed with zero runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.license).toBe('AGPL-3.0-only');
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(readFileSync(join(root, 'src/cli.ts'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});
