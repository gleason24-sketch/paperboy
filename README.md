# Paperboy

**The open-source growth engine. Articles that rank, written and published for you, with every number checked.**

Paperboy reads your Google Search Console, picks what to write from your own data, writes it, checks every claim against its source, publishes it to your site, and learns from what happens next. Run it yourself, or let your agent run it.

[![CI](https://github.com/gleason24-sketch/paperboy/actions/workflows/ci.yml/badge.svg)](https://github.com/gleason24-sketch/paperboy/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)

Built by a former law enforcement officer turned founder. Operated by Hive Asset Group, LLC.

> **Status: v0.1 alpha.** The engine, the fact check, the database, the self-host server, the Docker setup and the CLI are in this repository and tested. The MCP server and the agent plugins are not here yet: see the [roadmap](ROADMAP.md). The CLI is not on npm yet either, so the quickstart runs it from source.

## 60-second quickstart

You need Docker and an [Anthropic API key](https://console.anthropic.com).

```bash
git clone https://github.com/gleason24-sketch/paperboy.git
cd paperboy
cp .env.example .env        # set ANTHROPIC_API_KEY and the passwords
docker compose up --build   # Postgres + API server + worker, on http://localhost:3000
```

Then, in a second terminal (Node 22 or newer):

```bash
npm ci --prefix packages/cli && npm run build --prefix packages/cli
alias paperboy="node $PWD/packages/cli/dist/cli.js"

paperboy connect https://your-site.com --self-host http://localhost:3000
paperboy topics             # what it would write next, and why
paperboy write --wait       # research, write, fact check, then publish or hold
```

Prefer not to run anything? The hosted version at [paperboyseo.com](https://paperboyseo.com) writes your first article free, no card.

## Self-host or cloud

|  | Self-host (this repo) | Cloud ([paperboyseo.com](https://paperboyseo.com)) |
|---|---|---|
| Price | Free. You pay your own Anthropic bill. | Per site, per month. See [pricing](https://paperboyseo.com/pricing). |
| The loop (topics, research, writing, publish, rank loop) | Yes | Yes |
| Search Console sync | Yes, with your own Google OAuth client | Yes, one click |
| Fact check | Rule checks plus an open judge (rule-based, or Claude with your key) | The tuned hosted verifier |
| Cross-site learning | No | Yes |
| Hosted blog on your subdomain | Not in this repo yet (needs the web app) | Included |
| Dashboard | CLI and API for now | Web dashboard |
| Support | Community, GitHub issues | Email |

**What is open and what is not.** The loop is open (AGPL-3.0). Three things stay closed because they cost money to run or to tune: the calibrated fact-check verifier (its prompts, passage selection and scoring weights), cross-site learning, and billing. The open code reaches the closed parts only through two small interfaces, so nothing here is crippled and nothing here is a fork. If you self-host, you get the baseline checker. If you use the cloud, you get the premium one. We say so plainly because "everything is open" would not be true.

AGPL in one line: self-hosting for your own sites is free. If you modify it and offer it to other people as a service, you must publish your changes.

## The CLI

`@paperboyseo/cli` installs a `paperboy` command. Every command takes `--json` and works against the cloud or your own server (`--base-url`, or `connect --self-host`).

| Command | What it does |
|---|---|
| `paperboy connect [url]` | Log in with the OAuth device flow, add your site, connect Search Console. |
| `paperboy topics [--n 5]` | Show what it would write next and why: the query, the position, the impressions, the SERP-gate result. |
| `paperboy write [--topic] [--publish] [--wait]` | Research, write, fact check. Waits and prints the verdict. |
| `paperboy check <url or file.md>` | Fact check any URL or draft. Exit code 0 on pass, 1 on hold, so it works in CI. |
| `paperboy publish <article-id>` | Publish an approved article to the site's configured target. |
| `paperboy status` | Account, site, publishing target, Search Console state, latest articles. |
| `paperboy report [--days 28]` | Clicks, impressions and position, with a sparkline. |

Details, JSON shapes and exit codes: [packages/cli/README.md](packages/cli/README.md).

## MCP and agents

The MCP server will expose the same tools as the CLI, so Claude Code, Cursor, Codex, OpenClaw and n8n can run Paperboy for you: `list_sites`, `suggest_topics`, `write_article`, `fact_check`, `publish`, `get_performance`, `get_queries`. Publishing and spending always ask first (`publish` defaults to off).

Status: **not shipped yet.** The tool list and the REST API behind it are defined in [docs/mcp.md](docs/mcp.md) and [docs/api.md](docs/api.md). Until the MCP server lands, agents can call the CLI with `--json`, which is stable and designed for that.

## How the fact check works

Nothing passes because it sounds right. Every article is checked against the exact text of the sources that were read while researching it.

1. **Rules first.** Every number in a cited sentence must appear in the source text it links. Links must point at sources that were actually read. Banned claims, banned words and house style are matched exactly. A shown calculation is checked through its inputs.
2. **Then a judge.** Each cited sentence is compared with the passages of its source most likely to support it. The judge answers `supported`, `partly supported` or `not supported`.
3. **A verdict.** Every check ends in **VERIFIED** or **HELD**, with the quoted sentence, the problem and the fix. A held article gets one rewrite from that list and is checked again. If it still fails, it is not published.

The judge is a plug: `RuleJudge` needs no model at all (it scores how much of a sentence's wording is in the source), `FastModelJudge` uses your own Anthropic key, and `HostedVerifier` makes one API call to the tuned verifier. Set `PAPERBOY_VERIFIER=hosted` and `PAPERBOY_API_KEY` to use it. More in [docs/fact-check.md](docs/fact-check.md).

## What is in this repository

| Path | Contents |
|---|---|
| `packages/engine` | Topic selection and the SERP-strength gate, research, writing, the fact check, publish adapters (WordPress, Ghost, webhook, plus the hosted-blog and paste-in-prompt adapters that need the web app), Search Console sync, the rank loop, and the self-host API server and worker. |
| `packages/db` | Postgres migrations and the runner. |
| `packages/cli` | The `paperboy` command line tool. |
| `docs/` | Self-host guide, fact-check method, REST API, MCP plan. |
| `docker-compose.yml`, `Dockerfile` | One-command self-host. |

## Cost control

Writing costs real money on your own key. The engine stops an article that would cross a cap (6 web searches, 1.50 USD and 600,000 tokens by default, in `packages/engine/src/config/models.ts`) and holds it for review. Read [docs/self-host.md](docs/self-host.md) before you turn on the schedule.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md). Everyone follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

[AGPL-3.0](LICENSE). Copyright Hive Asset Group, LLC. The name and logo are not licensed: see [NOTICE](NOTICE).
