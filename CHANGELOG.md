# Changelog

All notable changes. Dates are UTC.

## 0.1.0 (unreleased)

- First public cut of the open engine: topic selection with the SERP-strength gate, research, writing, the fact check, publish adapters (WordPress, Ghost, webhook; the hosted-blog and paste-in-prompt adapters need the web app), Search Console sync, rank loop.
- Fact check: rule checks, the pluggable `Judge` interface, the open rule-based `RuleJudge`, a model judge for your own Anthropic key, and the optional hosted verifier.
- Self-host: Docker Compose with Postgres, an API server, a worker and a migration job.
- `@paperboyseo/cli`: connect, topics, write, check, publish, status, report, with `--json`.
- Migration test: all 14 migrations apply to a fresh in-memory Postgres (PGlite) on every test run.
- Database migrations renumbered into one clean sequence (the hosted product had two migrations sharing a number; they are now `0011` and `0012`).
