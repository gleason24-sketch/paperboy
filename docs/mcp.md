# MCP server (planned)

Not shipped yet. This page is the contract so that agents and the implementation agree.

The server will expose the REST API as tools, over stdio (`PAPERBOY_API_KEY`, optional `PAPERBOY_BASE_URL`) and as a remote Streamable HTTP endpoint with a bearer key.

| Tool | Input | Maps to |
|---|---|---|
| `list_sites` | none | `GET /api/v1/sites` |
| `suggest_topics` | `site`, `n?` | `POST /api/v1/sites/{id}/topics` |
| `write_article` | `site`, `topic?`, `target_query?`, `publish?` (default false) | `POST /api/v1/sites/{id}/articles`, returns a job id |
| `get_job` | `job_id` | `GET /api/v1/jobs/{id}` |
| `fact_check` | `url` or `markdown` | `POST /api/v1/fact-check` |
| `publish` | `article_id` | `POST /api/v1/articles/{id}/publish` |
| `get_performance` | `site`, `days?` | `GET /api/v1/sites/{id}/performance` |
| `get_queries` | `site`, `days?` | Search Console queries for the site |

Article runs take minutes, so `write_article` returns at once and the agent polls `get_job`. Tools that change the world say so in their description so clients ask first.

Until then, any agent can call the CLI with `--json`.
