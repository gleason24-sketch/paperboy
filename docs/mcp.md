# MCP server

`paperboy mcp` is a Model Context Protocol server over stdio. It exposes the REST API ([api.md](api.md)) as tools, so an AI agent can suggest topics, start articles, fact check text and publish. It lives in `packages/cli/src/commands/mcp.ts`, has no dependencies beyond the CLI, and speaks newline-delimited JSON-RPC 2.0 (protocol versions 2025-06-18, 2025-03-26 and 2024-11-05).

## Set up

Build the CLI once (it is not on npm), and sign in so the key is saved (`paperboy connect`), or pass the key in the environment:

```bash
npm ci --prefix packages/cli && npm run build --prefix packages/cli
node packages/cli/dist/cli.js connect --self-host http://localhost:3000
```

Claude Code:

```bash
claude mcp add paperboy -- node /path/to/paperboy/packages/cli/dist/cli.js mcp
```

Claude Desktop, Cursor and other clients take the same command in their JSON config:

```json
{
  "mcpServers": {
    "paperboy": {
      "command": "node",
      "args": ["/path/to/paperboy/packages/cli/dist/cli.js", "mcp"],
      "env": { "PAPERBOY_BASE_URL": "http://localhost:3000", "PAPERBOY_API_KEY": "pb_live_..." }
    }
  }
}
```

Without `PAPERBOY_BASE_URL` the server talks to `https://paperboyseo.com`. The server writes only protocol messages to stdout and its logs to stderr.

## Tools

| Tool | Input | Maps to | Side effects |
|---|---|---|---|
| `list_sites` | none | `GET /api/v1/sites` | none |
| `suggest_topics` | `site?`, `n?` | `POST /api/v1/sites/{id}/topics` | may spend a little on your model key |
| `write_article` | `site?`, `topic_id?`, `topic?` | `POST /api/v1/sites/{id}/articles` | **spends money**. Returns a job id at once. |
| `get_job` | `job_id` | `GET /api/v1/jobs/{id}` | none |
| `get_article` | `article_id` | `GET /api/v1/articles/{id}` | none |
| `fact_check` | `url` or `markdown`, `sources?` | `POST /api/v1/fact-check` | fetches the pages the draft cites |
| `publish_article` | `article_id` | `POST /api/v1/articles/{id}/publish` | **makes content public** |
| `get_performance` | `site?`, `days?` | `GET /api/v1/sites/{id}/performance` | none |

`site` is an id or a domain, and can be left out when the account has one site or a default is saved. Article runs take minutes, so `write_article` returns at once and the agent polls `get_job`, then reads the verdict with `get_article`.

The two tools with side effects say so in their descriptions and carry `readOnlyHint: false`, so clients ask before calling them. `write_article` always sends `publish: false`; whether a passed article goes live by itself follows the site's approval setting, which is `approve` by default on a self-host. A tool that fails returns an `isError` result with the message, not a protocol error.

## Paperboy Cloud

The hosted service runs a remote MCP server (Streamable HTTP) with its own tool list. It is documented at https://paperboyseo.com/docs/mcp:

```bash
claude mcp add --transport http paperboy https://paperboyseo.com/mcp --header "Authorization: Bearer pb_live_..."
```
