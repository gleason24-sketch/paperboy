# REST API (v1)

Base URL: your server, or `https://paperboyseo.com`. JSON in and out. Auth: `Authorization: Bearer pb_live_<key>`. Errors: `{ "error": { "code", "message", "request_id" } }`. Spending routes accept an `Idempotency-Key` header.

The self-host server in this repository implements these routes. The CLI is the reference client.

| Method and path | Purpose |
|---|---|
| `POST /api/v1/device/code` | Start a device login. No auth. Returns `device_code`, `user_code`, `verification_uri`, `interval`, `expires_in`. |
| `POST /api/v1/device/token` | Poll with the `device_code`. Returns `{ api_key }` when approved, or `400` with `authorization_pending`, `slow_down`, `expired_token`, `access_denied`. |
| `GET /api/v1/me` | Owner, key prefix, credits (`enabled: false` on a self-host). |
| `GET /api/v1/sites`, `POST /api/v1/sites` | List sites; add a site by URL. |
| `GET /api/v1/sites/{id}` | One site: publish method, Search Console state, latest articles. |
| `POST /api/v1/sites/{id}/gsc/connect` | Returns the Google OAuth URL to open in a browser. |
| `POST /api/v1/sites/{id}/topics` | `{ n }` topic suggestions with the reason and signals for each. |
| `POST /api/v1/sites/{id}/publishing` | Set where the site's articles go: `{ "method": "wordpress" \| "ghost" \| "webhook", ... }` with `wp_url`, `wp_user`, `wp_app_password`, or `ghost_url`, `ghost_admin_key`, or `webhook_url`. The connection is tested first: `422` with the reason if it fails, nothing saved. |
| `POST /api/v1/sites/{id}/articles` | Start an article. Send `topic_id` (from the topics list) or `topic` (free text); send neither and the pipeline picks one. `202` with `job_id` and `article_id`. Whether it publishes by itself follows the site's approval setting (`approve` by default on a self-host); the `publish` flag in the body is accepted and ignored. |
| `GET /api/v1/jobs/{id}` | `queued`, `running`, `done` or `failed`, with the current step. |
| `GET /api/v1/articles/{id}` | Title, status, URL and the verdict with its checks. |
| `POST /api/v1/articles/{id}/publish` | Publish to the site's configured target. An article held by the fact check answers `409 fact_check_failed` unless the body has `{ "force": true }`. |
| `POST /api/v1/fact-check` | `{ url }` or `{ markdown }`. Returns `pass`, `claims_total`, `claims_verified` and `checks[]`. |
| `POST /api/v1/verify` | Body is a `QualityInput`; returns `{ verdict }`. This is what `HostedVerifier` calls. |
| `GET /api/v1/sites/{id}/performance?days=28` | Totals and daily rows from Search Console. |
| `POST /api/v1/sites/{id}/reports` | `{ days }`. Returns a Markdown report and its data. |

Keys are stored as SHA-256 hashes in `api_keys`. Every query is filtered by the key's owner, because the server connection bypasses row-level security.
