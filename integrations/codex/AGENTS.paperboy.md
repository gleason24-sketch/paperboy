<!-- BEGIN:paperboy -->
## Paperboy (SEO articles with a fact check)

Use the `paperboy` MCP server (https://paperboyseo.com/mcp, bearer API key in `PAPERBOY_API_KEY`) for blog topics, articles, fact checks and Search Console numbers. Docs: https://paperboyseo.com/docs

- `get_sites` first. It is free.
- Costs: `suggest_topics` 1 credit, `write_article` 12 credits, `check_claims` 2 credits. Reads and `publish_article` are free. Say the cost before a spending call.
- `write_article` returns an id at once. Poll `get_article` until the status is `published` or `needs_review`.
- Keep `publish` false and ask the user before calling `publish_article`.
- Never write the API key into the repo.
<!-- END:paperboy -->
