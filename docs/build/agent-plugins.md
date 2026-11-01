# Agent plugins: build notes

Goal: install Paperboy in every popular coding agent with one command. Status: built, local, not pushed. Nothing has been published to ClawHub or any registry.

## Files

| Path | What |
|---|---|
| `skills/paperboy/SKILL.md` | Canonical skill. Found by `npx skills add <owner>/<repo>`. |
| `.claude-plugin/marketplace.json` | Claude Code marketplace `paperboy`, one plugin from `./plugins/paperboy`. |
| `plugins/paperboy/.claude-plugin/plugin.json` | Plugin manifest. |
| `plugins/paperboy/.mcp.json` | Hosted MCP server, `type: http`, `Authorization: Bearer ${PAPERBOY_API_KEY}`. |
| `plugins/paperboy/skills/paperboy/SKILL.md` | Generated copy (a plugin must contain its own files). |
| `integrations/openclaw/paperboy/SKILL.md` | Generated, ClawHub frontmatter (`metadata.openclaw`). |
| `integrations/hermes/paperboy/SKILL.md` | Generated, Hermes frontmatter. |
| `integrations/cursor/paperboy.mdc`, `integrations/codex/AGENTS.paperboy.md` | Rule and AGENTS.md snippets. |
| `scripts/sync-agent-skills.mjs` | Regenerates the copies from the canonical skill. `--check` fails on drift. |
| `docs/agents.md` | One-line install per agent. Linked from `README.md`. |

## Verified vs unverified

VERIFIED by running it:
- Skills CLI layout: `npx -y skills add /computer/repos/pbo-agent-plugins --list` (temp HOME) found 1 skill, `paperboy`. Layout rules read from vercel-labs/skills docs (`skills/<name>/SKILL.md`, frontmatter `name` and `description`).
- Claude Code plugin and marketplace: `claude plugin validate .` and `claude plugin validate plugins/paperboy` both pass (Claude Code 2.1.287). Then, with a temp HOME, `claude plugin marketplace add <local path>` and `claude plugin install paperboy@paperboy` succeeded; `claude plugin details paperboy` shows Skills (1) and MCP servers (1). Formats read from code.claude.com plugin, marketplace and MCP docs. `${PAPERBOY_API_KEY}` expansion in `headers` is documented there.
- Repo checks: `npm run install:all`, `npm run typecheck`, `npm test` all pass (engine 113 tests, cli 53, db 2).

VERIFIED against official docs only (not run, no CLI available):
- Cursor `.cursor/mcp.json` with `${env:NAME}` (cursor.com/docs/context/mcp), Cursor rule frontmatter.
- Codex `codex mcp add ... --url ... --bearer-token-env-var` and `bearer_token_env_var` in config.toml (Codex docs).
- ClawHub skill format: docs.openclaw.ai/clawhub/skill-format (frontmatter, `metadata.openclaw.requires.env`, `primaryEnv`, `envVars`) and publish command `clawhub skill publish <path>`; install `clawhub install <slug>` / `openclaw skills install <slug>`.
- Hermes skill format: hermes-agent.nousresearch.com/docs/developer-guide/creating-skills (frontmatter, `required_environment_variables`, `metadata.hermes`); install `hermes skills install owner/repo/skills/name` and `hermes skills tap add owner/repo`.

UNVERIFIED:
- The OpenClaw and Hermes SKILL.md files were not loaded by their real CLIs. In particular: whether ClawHub wants the slug scoped (`@publisher/paperboy`), and whether Hermes accepts an uncategorised skill directory when installed from a tap path.
- `docs/agents.md` says `clawhub install paperboy` works. It will not until the skill is published (`clawhub skill publish integrations/openclaw/paperboy --slug paperboy --name Paperboy --version 0.1.0`). ClawHub licenses everything MIT-0, which differs from this repo's AGPL; check that before publishing.
- The skills CLI `--agent` values (`claude-code`, `cursor`, `codex`) were not each tried.
- The hosted server behaviour (401 without a key, OAuth) was taken from the task brief, not tested. `schedule_article` and `get_site_report` credit costs are not stated in the skill because they are unknown.

## Before this works for real users

1. Push, and make sure `.claude-plugin/marketplace.json`, `skills/` and `plugins/` are on the repo default branch (the branch `bot/initial` is not enough). `/plugin marketplace add <owner>/paperboy` reads the default branch.
2. The repo is in the `paperboyseo` org.
3. Optionally publish the OpenClaw skill and submit the plugin to Anthropic's directory (needs the human).

## Owner

The repo lives at `paperboyseo/paperboy` (moved 2026-11-01).

## Continuing

Edit only `skills/paperboy/SKILL.md`, then run `node scripts/sync-agent-skills.mjs`. Re-validate with `claude plugin validate .`.
