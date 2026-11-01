#!/usr/bin/env node
// Keeps every agent-facing copy of the Paperboy skill in step with skills/paperboy/SKILL.md.
// `node scripts/sync-agent-skills.mjs`         rewrites the copies.
// `node scripts/sync-agent-skills.mjs --check` exits 1 if a copy is stale (for CI).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = readFileSync(join(root, 'skills/paperboy/SKILL.md'), 'utf8');
const m = canonical.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!m) throw new Error('skills/paperboy/SKILL.md has no frontmatter');
const body = m[2];
const description = m[1].match(/^description: (.*)$/m)[1];

// OpenClaw / ClawHub: metadata.openclaw declares the credential. UNVERIFIED against a live publish.
const openclaw = `---
name: paperboy
description: ${description}
version: 0.1.0
metadata:
  openclaw:
    requires:
      env:
        - PAPERBOY_API_KEY
    primaryEnv: PAPERBOY_API_KEY
    envVars:
      - name: PAPERBOY_API_KEY
        required: true
        description: Paperboy API key (pb_live_...). Create one at https://paperboyseo.com/app/settings/api.
    emoji: "📰"
    homepage: https://paperboyseo.com
---
${body}`;

// Hermes Agent: version/author/license/platforms/metadata.hermes per the creating-skills guide.
const hermes = `---
name: paperboy
description: ${description}
version: 0.1.0
author: Paperboy
license: AGPL-3.0-only
platforms: [macos, linux, windows]
required_environment_variables:
  - name: PAPERBOY_API_KEY
    prompt: "Your Paperboy API key"
    help: "Create one at https://paperboyseo.com/app/settings/api"
    required_for: "the Paperboy hosted MCP server"
metadata:
  hermes:
    tags: [SEO, Content, Fact-checking]
---
${body}`;

const targets = [
  ['plugins/paperboy/skills/paperboy/SKILL.md', canonical],
  ['integrations/openclaw/paperboy/SKILL.md', openclaw],
  ['integrations/hermes/paperboy/SKILL.md', hermes],
];

let stale = 0;
for (const [rel, content] of targets) {
  const file = join(root, rel);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (current === content) continue;
  if (process.argv.includes('--check')) {
    console.error(`stale: ${rel}`);
    stale++;
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    console.log(`wrote ${rel}`);
  }
}
if (stale) process.exit(1);
