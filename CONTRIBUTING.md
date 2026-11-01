# Contributing to Paperboy

Thanks for helping. This project is small and the rules are short.

## Ground rules

- Open an issue before a large change. Small fixes can go straight to a pull request.
- Every number or claim in docs and in example articles must be checkable. No made-up stats, no invented customers.
- No em dashes or en dashes in docs, comments or output. Use a period, comma or colon.
- Keep secrets out of the repo. `.env` files, keys and database URLs never get committed. `npm run scrub` fails the build on known patterns.
- One purpose per pull request, with tests for behavior you change.
- Be kind. Everyone follows the [code of conduct](CODE_OF_CONDUCT.md).

## Dev setup

You need Node 22 or newer. Docker is only needed to run the full stack.

```bash
git clone https://github.com/paperboyseo/paperboy.git && cd paperboy
npm run install:all     # npm ci in packages/engine, packages/cli and packages/db
npm run typecheck
npm test
npm run scrub
```

The packages install on their own (there is no workspace hoisting), so run `npm ci` in each package you touch. Run one package's tests with `npm test --prefix packages/engine` (or `cli`, `db`).

To run the stack from source, `docker compose up --build` as in the [README](README.md). The engine and server run straight from TypeScript with `tsx` (`packages/engine`: `npx tsx src/server/server.ts`, `npx tsx src/server/worker.ts`), against any Postgres you point `DATABASE_URL` and `SERVER_DATABASE_URL` at.

## Layout

| Path | What it is |
|---|---|
| `packages/engine` | The loop: topics, research, writing, fact check, publish adapters, GSC sync, rank loop, and the self-host server and worker. |
| `packages/db` | Postgres migrations and the runner. New migrations get the next number and must apply cleanly on top of the earlier ones (a test checks it). |
| `packages/cli` | The `paperboy` command line tool and the MCP server. Zero runtime dependencies: keep it that way. |
| `docs/` | Self-host, fact check, API and MCP docs. |

## Tests

- Engine and CLI use Vitest, the db package uses `node --test`. Tests do not need a database, a network or an API key: the server tests use a fake SQL function (`packages/engine/tests/server/fake-sql.ts`) and the CLI tests run against a local mock HTTP server.
- Changing the fact check? Add a case to `packages/engine/tests/quality.test.ts` or `rule-judge.test.ts` that fails without your change.
- Changing the REST API? Update `docs/api.md` in the same pull request.

## Code style

- TypeScript, strict mode. Match the file you are in: naming, comment density and idiom.
- Comments say why, not what. Keep them short.
- Engine code imports with the `@/` alias. The CLI uses relative `.js` imports.
- Plain, specific wording in user-facing text. No hype.
- No new dependency without a reason in the pull request description. The CLI takes none.

## Pull requests

1. Fork, then branch from the default branch.
2. Run `npm run typecheck`, `npm test` and `npm run scrub` before you push.
3. Fill in the pull request template: what changed, why, how you checked it.
4. A maintainer reviews it. Expect questions rather than a quick merge on anything that touches the fact check.

There is no sign-off or CLA step. By opening a pull request you license your contribution under AGPL-3.0-only, like the rest of the project, and you agree that Hive Asset Group, LLC may also distribute it under other terms. That second part is what lets the hosted product keep closed modules next to the open engine.

## The closed verifier boundary

The tuned fact-check verifier, cross-site learning and billing live in a private repository. The open code talks to them through two interfaces only: `Verifier` (`packages/engine/src/lib/quality/verifier.ts`) and `Judge` (`packages/engine/src/lib/quality/types.ts`). Pull requests that add a hard dependency on anything outside this repository will be declined. Improvements to the open rule checks and the open judge are very welcome.

## Releases

Maintainers: the weekly release routine and the post generator are described in [RELEASING.md](RELEASING.md).

## Reporting bugs and security issues

Bugs and ideas: use the issue templates. Security: email security@paperboyseo.com, see [SECURITY.md](SECURITY.md), and do not open a public issue.
