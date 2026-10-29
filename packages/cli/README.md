# @paperboyseo/cli

The command line for [Paperboy](https://paperboyseo.com), the open-source growth engine. Paperboy reads your Google Search Console data, picks topics worth writing, writes and fact-checks articles, publishes them and measures the result. This CLI drives all of that from your terminal or from CI.

- Zero runtime dependencies, Node 22 or newer.
- Works against the hosted service (`https://paperboyseo.com`) or your own self-hosted instance.
- Every command has a stable `--json` mode.

## Install

Run it without installing:

```sh
npx @paperboyseo/cli connect
```

Or install it globally and use the `paperboy` command (also available as `paperboy-seo`):

```sh
npm i -g @paperboyseo/cli
paperboy connect
```

Note: the unscoped npm package named `paperboy` is a different project, so `npx paperboy` will not run this CLI. Use `npx @paperboyseo/cli ...`.

## Quick start

```sh
paperboy connect https://yoursite.com   # sign in, add the site, connect Search Console
paperboy topics                         # what should we write next?
paperboy write --topic top_abc123 --wait
paperboy report
```

## Commands

Global flags: `--json`, `--site <id|domain>`, `--api-key <key>`, `--base-url <url>`, `--no-color`, `--yes`, `--help`, `--version`.

### connect

```sh
paperboy connect [site-url] [--self-host <baseUrl>] [--api-key <key>] [--no-wait] [--no-open]
```

Signs in with the OAuth 2.0 device flow: the CLI prints a short code and a URL, opens your browser, and waits until you approve. The API key is saved to the config file. With `--api-key` the browser step is skipped and the key you paste is verified and saved.

If you pass a site URL, Paperboy adds the site, saves it as your default, and walks you through the Search Console authorization. The CLI waits up to 5 minutes for it to complete; use `--no-wait` to just print the link.

```sh
paperboy connect https://yoursite.com
paperboy connect --self-host http://localhost:3000
paperboy connect --api-key pb_live_xxxxxxxx --self-host https://paperboy.example.com
```

### topics

```sh
paperboy topics [--n 5]
```

Lists the best topics to write next, each with why it was picked and the signals behind it (impressions, average position, SERP gate).

```
1. Best coffee grinders  [top_1]
   query: best coffee grinder
   why: Page two with rising impressions
   signals: 12,400 impressions, position 11.3, serp gate: pass
```

### write

```sh
paperboy write [--topic <id|"free text">] [--publish] [--wait | --no-wait]
```

Starts an article job. `--topic` takes a topic id from `paperboy topics`, or free text in quotes (anything containing whitespace is treated as text). Without `--topic` Paperboy picks one. With `--wait` (the default on a terminal) the CLI follows the job, then prints the title, status, URL and the fact-check summary (claims verified and held). Without it, the job id is printed and the command returns immediately. Each write sends an `Idempotency-Key` so retries never double-charge credits.

### check

```sh
paperboy check <url|file.md> [--sources sources.txt]
```

Fact-checks a live URL or a local markdown file. `--sources` is a text file with one source URL or note per line (blank lines and lines starting with `#` are ignored). Claims are reported as VERIFIED, HELD, UNSUPPORTED or MISMATCH. The exit code is 0 when the check passes and 1 when it does not, so it drops straight into CI:

```sh
paperboy check docs/launch-post.md || exit 1
```

### publish

```sh
paperboy publish <article-id>
```

Publishes an article through the site's configured publish method. On a terminal it asks for confirmation unless you pass `--yes`.

### status

```sh
paperboy status
```

Shows the account owner, the credits balance (when credits are enabled), the site domain, its publish method, whether Search Console is connected, and the latest articles.

### report

```sh
paperboy report [--days 28] [--markdown]
```

Prints totals (clicks, impressions, average position, CTR), a unicode sparkline of daily clicks and the last seven days. With `--markdown` the server renders a full markdown report instead.

## Choosing a site

Resolution order: `--site <id|domain>`, then the saved `default_site`, then the only site on your account. If you have several sites and none is selected, the CLI lists them and exits with an error.

## JSON output

With `--json`, every command prints exactly one JSON object on stdout and nothing else. Progress text and the device-flow code go to stderr.

Success:

```json
{ "ok": true, "command": "topics", "data": { "topics": [] } }
```

`data` is the API response for the command (for `write --wait` it is `{ "job_id", "article" }`, for `connect` it holds the base URL, a masked key preview, the config path and the site).

Failure:

```json
{ "ok": false, "error": { "code": "unauthorized", "message": "...", "status": 401 } }
```

`status` is present for HTTP errors. Error codes come from the API when available, plus CLI codes such as `usage`, `network_error`, `timeout`, `bad_response`, `job_failed`, `site_required`, `no_site`, `expired_token` and `access_denied`.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | Success (for `check`: the fact-check passed) |
| 1 | `check` did not pass, or `publish` did not publish |
| 2 | Error: bad usage, network or API error, job failure |

In `--json` mode a failing `check` still prints `"ok": true` (the command ran) with `data.pass` set to `false`, and exits 1.

## Configuration

Settings resolve in this order: command-line flag, then environment variable, then config file.

| Setting | Flag | Environment | Config key |
| ------- | ---- | ----------- | ---------- |
| API key | `--api-key` | `PAPERBOY_API_KEY` | `api_key` |
| Base URL | `--base-url` | `PAPERBOY_BASE_URL` | `base_url` |
| Site | `--site` | none | `default_site` |

The config file lives at `~/.config/paperboy/config.json` (or `$XDG_CONFIG_HOME/paperboy/config.json`; `PAPERBOY_CONFIG_DIR` overrides the directory). The directory is created with mode 0700 and the file with mode 0600. The CLI never prints your API key, only the first 12 characters followed by `...`.

Other environment variables: `NO_COLOR` (disable color), `FORCE_COLOR` (enable color), `PAPERBOY_NO_OPEN=1` (never open a browser).

## Self-hosting

Point the CLI at your own instance once and it remembers:

```sh
paperboy connect --self-host http://localhost:3000
paperboy status
```

Or per command: `paperboy topics --base-url http://localhost:3000`, or set `PAPERBOY_BASE_URL`.

## Development

```sh
npm install
npm run build
npm test
```

Tests run the CLI end to end against a local mock HTTP server.

## License

AGPL-3.0-only, copyright Hive Asset Group, LLC. See the LICENSE file in this package.
