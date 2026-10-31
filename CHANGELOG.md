# Changelog

All notable changes. Dates are UTC.

## 0.1.0 (2026-10-31)

Release notes: [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md).


- First public cut of the open engine: topic selection with the SERP-strength gate, research, writing, the fact check, publish adapters (WordPress, Ghost, webhook; the hosted-blog and paste-in-prompt adapters need the web app), Search Console sync, rank loop.
- Fact check: rule checks, the pluggable `Judge` interface, the open rule-based `RuleJudge`, a model judge for your own Anthropic key, and the optional hosted verifier.
- Self-host: Docker Compose with Postgres, an API server, a worker and a migration job.
- `@paperboyseo/cli`: connect, topics, write, check, publish, status, report, mcp, with `--json`. Run from source; it is not on npm.
- `paperboy mcp`: a stdio MCP server with eight tools (list_sites, suggest_topics, write_article, get_job, get_article, fact_check, publish_article, get_performance).
- `POST /api/v1/sites/{id}/publishing` on the self-host server: set and test a WordPress, Ghost or webhook target.
- `POST /api/v1/sites/{id}/articles` with no topic lets the pipeline pick one, so `paperboy write` works on its own.
- Safe self-host defaults: `PAPERBOY_ARTICLES_PER_WEEK=0` (the worker starts nothing by itself) and new sites hold passed articles for approval (`PAPERBOY_APPROVAL_MODE`).
- `PAPERBOY_ARTICLES_PER_WEEK` overrides a site's plan pace when it is set.
- `paperboy connect` keeps going when the server has no Google OAuth client.
- Migration test: all 14 migrations apply to a fresh in-memory Postgres (PGlite) on every test run.
- Database migrations renumbered into one clean sequence (the hosted product had two migrations sharing a number; they are now `0011` and `0012`).
