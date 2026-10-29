# Self-host

Postgres, an API server and a worker, in Docker Compose.

## Run it

```bash
cp .env.example .env
docker compose up --build
```

`.env` needs `ANTHROPIC_API_KEY`, `POSTGRES_PASSWORD`, `PAPERBOY_DB_PASSWORD`, `APP_SECRET`, `PAPERBOY_ADMIN_EMAIL` and `PAPERBOY_ADMIN_PASSWORD`. Compose refuses to start if a password is missing.

What starts:

| Service | Job |
|---|---|
| `db` | Postgres 16 with a named volume (`pgdata`). |
| `migrate` | Runs once: applies `packages/db/migrations`, sets the password of the `paperboy_server` role, creates the operator account. |
| `web` | The API server on port 3000. Health check: `GET /api/health`. |
| `worker` | Runs planned articles and the timers: hourly schedule, daily Search Console pull at 06:15 UTC, weekly report on Mondays, rank loop daily. |

## Log in

The CLI uses a device flow. Run `paperboy connect --self-host http://localhost:3000`, open the printed URL, enter the code and the admin password from `.env`.

## Search Console

Create a Google OAuth client of type Web application. Add `<NEXT_PUBLIC_APP_URL>/api/gsc/callback` as an authorized redirect URI, and put the client id and secret in `.env`. The only scope requested is `webmasters.readonly`. Google ties OAuth verification to one app, which is why a self-host brings its own client.

## Cost

You pay Anthropic directly. Defaults in `packages/engine/src/config/models.ts`: 6 web searches, 1.50 USD and 600,000 tokens per article, then the article is held. Start with `PAPERBOY_ARTICLES_PER_WEEK=3` and read your usage before raising it.

## Publishing

Per site, from the self-host server today: WordPress (application password), Ghost (Admin API key) and a signed webhook. The hosted blog on a subdomain and the paste-in prompt feed need the web app, which is not part of this repository yet (see the roadmap), so those two adapters exist in `src/lib/publish` but have nothing to serve them on a plain self-host.

## Upgrade and backup

```bash
git pull
docker compose up --build -d    # the migrate job applies new migrations
docker compose exec db pg_dump -U postgres paperboy > backup.sql
```

## Supabase instead of the bundled Postgres

The schema also runs on a Supabase project (skip `PAPERBOY_DB_SHIM`, which only exists to fake the `auth` schema on plain Postgres). Point `DATABASE_URL` at the admin connection and `SERVER_DATABASE_URL` at the `paperboy_server` role.
