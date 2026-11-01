# Install Paperboy in your coding agent

Paperboy Cloud runs a remote MCP server at `https://paperboyseo.com/mcp` (Streamable HTTP). It takes an API key as `Authorization: Bearer <key>` and also supports OAuth. Create a key at https://paperboyseo.com/app/settings/api and keep it in an environment variable. Never put it in a file in your project.

```bash
export PAPERBOY_API_KEY=pb_live_...
```

Two things get installed: a **skill** (instructions on when and how to use Paperboy, including the cost and approval rules) and the **MCP server** (the tools). The Claude Code plugin installs both. The other routes install one or the other, so use the skill line and the MCP line for your agent.

The tools are `get_sites`, `suggest_topics`, `write_article`, `get_article`, `check_claims`, `publish_article`, `get_performance`, `get_queries`, `get_site_report` and `schedule_article`.

## Skill, any agent (skills CLI)

```bash
npx skills add gleason24-sketch/paperboy
```

This uses the [skills CLI](https://github.com/vercel-labs/skills) and finds `skills/paperboy/SKILL.md`. Add `--agent claude-code`, `--agent cursor`, `--agent codex` and so on to pick targets, or `--list` to see what is in the repo first.

## Claude Code

Plugin (skill and MCP server together):

```text
/plugin marketplace add gleason24-sketch/paperboy
/plugin install paperboy@paperboy
```

The plugin reads `PAPERBOY_API_KEY` from your environment, so export it before you start Claude Code.

MCP server only:

```bash
claude mcp add --transport http paperboy https://paperboyseo.com/mcp --header "Authorization: Bearer $PAPERBOY_API_KEY"
```

Or leave out `--header` and run `/mcp` inside Claude Code to sign in with OAuth.

## Cursor

MCP server: add this to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). Cursor expands `${env:NAME}` in `url` and `headers`.

```json
{
  "mcpServers": {
    "paperboy": {
      "url": "https://paperboyseo.com/mcp",
      "headers": { "Authorization": "Bearer ${env:PAPERBOY_API_KEY}" }
    }
  }
}
```

Rule: copy [`integrations/cursor/paperboy.mdc`](../integrations/cursor/paperboy.mdc) to `.cursor/rules/paperboy.mdc`, or run the skills CLI line above with `--agent cursor`.

## Codex

```bash
codex mcp add paperboy --url https://paperboyseo.com/mcp --bearer-token-env-var PAPERBOY_API_KEY
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.paperboy]
url = "https://paperboyseo.com/mcp"
bearer_token_env_var = "PAPERBOY_API_KEY"
```

Instructions: append [`integrations/codex/AGENTS.paperboy.md`](../integrations/codex/AGENTS.paperboy.md) to your `AGENTS.md`, or use the skills CLI line above with `--agent codex`.

## OpenClaw

```bash
clawhub install paperboy
```

or `openclaw skills install paperboy`. The skill source is [`integrations/openclaw/paperboy`](../integrations/openclaw/paperboy). It has not been published to ClawHub yet, so until it is, copy that folder into your OpenClaw workspace `skills/` directory. Set `PAPERBOY_API_KEY` in the environment OpenClaw runs in.

## Hermes Agent

```bash
hermes skills install gleason24-sketch/paperboy/skills/paperboy
```

Or add the repository as a tap with `hermes skills tap add gleason24-sketch/paperboy`. A copy in Hermes frontmatter is in [`integrations/hermes/paperboy`](../integrations/hermes/paperboy). Set `PAPERBOY_API_KEY` in `~/.hermes/.env` or your shell.

## Self-hosted

These routes point at Paperboy Cloud. To use your own server, see [mcp.md](mcp.md) for the stdio server (`paperboy mcp`).

## Keeping the copies in step

`skills/paperboy/SKILL.md` is the source. The Claude Code plugin, OpenClaw and Hermes copies are generated from it:

```bash
node scripts/sync-agent-skills.mjs          # rewrite the copies
node scripts/sync-agent-skills.mjs --check  # fail if one is stale
```
