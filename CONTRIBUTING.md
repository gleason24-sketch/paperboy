# Contributing to Paperboy

Thanks for helping. This project is small and the rules are short.

## Ground rules

- Open an issue before a large change. Small fixes can go straight to a pull request.
- Every number or claim in docs and in example articles must be checkable. No made-up stats, no invented customers.
- No em dashes or en dashes in docs, comments or output. Use a period, comma or colon.
- Keep secrets out of the repo. `.env` files, keys and database URLs never get committed. CI runs a secret scan and `npm run scrub`.
- One purpose per pull request, with tests for behavior you change.

## Set up

Node 22 or newer.

```bash
npm ci --prefix packages/engine
npm ci --prefix packages/cli
npm run typecheck
npm test
```

The packages install on their own (there is no workspace hoisting), so run `npm ci` in each package you touch.

## Layout

| Path | What it is |
|---|---|
| `packages/engine` | The loop: topics, research, writing, fact check, publish adapters, GSC sync, rank loop, and the self-host server and worker. |
| `packages/db` | Postgres migrations and the runner. |
| `packages/cli` | The `paperboy` command line tool. |
| `docs/` | Self-host, fact check, API and MCP notes. |

## Pull requests

1. Fork, then branch from the default branch.
2. Run `npm run typecheck`, `npm test` and `npm run scrub` before you push.
3. In the description say what changed, why, and how you checked it.
4. By opening a pull request you agree that your contribution is licensed under AGPL-3.0-only and that Hive Asset Group, LLC may also distribute it under other terms (this is what lets the hosted product keep closed modules next to the open engine). Sign off your commits with `git commit -s` (Developer Certificate of Origin).

## The closed verifier boundary

The tuned fact-check verifier, cross-site learning and billing live in a private repository. The open code talks to them through two interfaces only: `Verifier` (`packages/engine/src/lib/quality/verifier.ts`) and the `Judge` interface. Pull requests that add a hard dependency on anything outside this repository will be declined. Improvements to the open rule checks and the open judge are very welcome.

## Reporting bugs and security issues

Bugs: use the issue templates. Security: see [SECURITY.md](SECURITY.md), and do not open a public issue.
