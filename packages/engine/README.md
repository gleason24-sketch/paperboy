# @paperboyseo/engine

The Paperboy loop as a library, plus the self-host API server and worker.

| Path | What |
|---|---|
| `src/lib/engine` | `runArticle` pipeline, topic selection, the SERP-strength gate, research, writing, site scan. |
| `src/lib/quality` | The fact check: rule checks, `Judge`, `RuleJudge`, `Verifier`, `HostedVerifier`, `registerVerifier`. |
| `src/lib/publish` | Publish adapters: hosted blog, WordPress, Ghost, webhook, paste-in prompt. |
| `src/lib/rankloop` | Opportunities from Search Console, title and meta rewrites, before and after measurement. |
| `src/lib/gsc.ts` | Search Console OAuth (read-only scope) and the daily sync. |
| `src/lib/jobs.ts` | Scheduling: what is due this hour, the daily pull, the weekly report. |
| `src/server` | The REST API server (`server.ts`), the worker (`worker.ts`) and the operator seed (`seed.ts`). |

Imports use the `@/` alias for `src/`. Run files with `npx tsx`. Tests: `npm test`. Types: `npm run typecheck`.
