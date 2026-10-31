# Self-host

Postgres, an API server and a worker, in Docker Compose.

## Run it

```bash
git clone https://github.com/paperboyseo/paperboy.git && cd paperboy
cp .env.example .env
docker compose up --build
```

`.env` needs `ANTHROPIC_API_KEY`, `POSTGRES_PASSWORD`, `PAPERBOY_DB_PASSWORD`, `APP_SECRET` (24 or more characters), `PAPERBOY_ADMIN_EMAIL` and `PAPERBOY_ADMIN_PASSWORD`. Compose refuses to start if a password is missing. Use letters and digits for the two database passwords (`openssl rand -hex 24`): they go into connection URLs. Every variable is listed in the [README](../README.md#configuration).

Check it: `curl http://localhost:3000/api/health` answers `{"ok":true,"db":true,...}`.

## Migrations

You do not run migrations by hand. The `migrate` service runs `packages/db/migrate.mjs` on every `docker compose up`, before the API server and the worker start (they wait for it to finish). It applies each file in `packages/db/migrations` once, in order, inside a transaction, and records it in `public.schema_migrations`, so a restart or an upgrade only applies what is new. It also sets the password of the `paperboy_server` role from `PAPERBOY_DB_PASSWORD`, and `seed.ts` creates the operator account if it is missing. If a migration fails, `migrate` exits with an error, `web` and `worker` do not start, and `docker compose logs migrate` shows why.

What starts:

| Service | Job |
|---|---|
| `db` | Postgres 16 with a named volume (`pgdata`). |
| `migrate` | Runs once: applies `packages/db/migrations`, sets the password of the `paperboy_server` role, creates the operator account. |
| `web` | The API server on port 3000. Health check: `GET /api/health`. |
| `worker` | Runs planned articles and the timers: hourly schedule, daily Search Console pull at 06:15 UTC, weekly report on Mondays, rank loop daily. |

## Log in

The CLI uses a device flow. Build it from source (it is not on npm): `npm ci --prefix packages/cli && npm run build --prefix packages/cli`, then run `node packages/cli/dist/cli.js connect https://your-site.com --self-host http://localhost:3000`. Open the printed URL, enter the code and the admin password from `.env` (the page asks for the code and the password, not the email). The key is saved to `~/.config/paperboy/config.json`.

## Search Console

Optional: without it, `connect` skips Search Console, and `check`, `write` with a topic and `publish` still work. Create a Google OAuth client of type Web application. Add `<NEXT_PUBLIC_APP_URL>/api/gsc/callback` as an authorized redirect URI, and put the client id and secret in `.env`. The only scope requested is `webmasters.readonly`. Google ties OAuth verification to one app, which is why a self-host brings its own client.

## Cost

You pay Anthropic directly. Defaults in `packages/engine/src/config/models.ts`: 6 web searches, 1.50 USD and 600,000 tokens per article, then the article is held.

`.env.example` ships with `PAPERBOY_ARTICLES_PER_WEEK=0`: the worker's hourly schedule starts nothing, and an article is written only when you run `paperboy write` (with no `--topic` the pipeline picks one). To put it on autopilot, set a pace such as `PAPERBOY_ARTICLES_PER_WEEK=3` and restart. The schedule then starts that many articles per site per week, and refreshes an underperforming article now and then. Read your Anthropic usage for a week before raising it.

## Approval

Sites you add through the API default to `approve`: an article that passes the fact check waits, and `paperboy publish <article-id>` (or the MCP tool) publishes it. The job shows as done with the note that it is waiting for approval. Set `PAPERBOY_APPROVAL_MODE=autopilot` to publish passed articles by yourself. An article that fails the fact check twice is never published automatically, in either mode.

## Publishing

A new site publishes to `hosted` unless you say otherwise, and the hosted blog needs the web app, which is only in Paperboy Cloud. On a self-host, pick WordPress, Ghost or a signed webhook for each site. The server tests the connection before it saves anything, and keeps the secrets in the `site_secrets` table.

```bash
KEY=$(grep -o 'pb_live_[A-Za-z0-9_]*' ~/.config/paperboy/config.json | head -1)
SITE=<site id from `paperboy status`>

# WordPress (an application password: Users, Profile, Application passwords)
curl -X POST http://localhost:3000/api/v1/sites/$SITE/publishing -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"method":"wordpress","wp_url":"https://blog.example.com","wp_user":"editor","wp_app_password":"abcd efgh ijkl mnop"}'

# Ghost (Admin API key)
#   -d '{"method":"ghost","ghost_url":"https://example.ghost.io","ghost_admin_key":"<id>:<secret>"}'
# Signed webhook (https only; the body is signed with a secret the server generates)
#   -d '{"method":"webhook","webhook_url":"https://example.com/hooks/paperboy"}'
```

A bad password or an unreachable site comes back as a `422` with the reason, and nothing is saved. Set `PAPERBOY_PUBLISH_METHOD` to change the default for sites you add later. The `prompt` method (a paste-in prompt feed) also needs the web app.

## Upgrade and backup

```bash
git pull
docker compose up --build -d    # the migrate job applies new migrations
docker compose exec db pg_dump -U postgres paperboy > backup.sql
```

## Supabase instead of the bundled Postgres

The schema also runs on a Supabase project (skip `PAPERBOY_DB_SHIM`, which only exists to fake the `auth` schema on plain Postgres). Point `DATABASE_URL` at the admin connection and `SERVER_DATABASE_URL` at the `paperboy_server` role.
