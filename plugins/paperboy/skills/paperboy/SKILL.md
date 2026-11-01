---
name: paperboy
description: Use Paperboy to suggest SEO topics for a site, write a fact-checked article, fact check any URL or draft, publish or schedule it, and read Search Console performance. Use when the user asks about blog content, SEO articles, fact checking claims or sources, or how their articles are ranking.
---

# Paperboy

Paperboy writes SEO articles and fact checks every cited claim against the saved text of its source. An article that fails the check is held, not published.
Docs: https://paperboyseo.com/docs

## Setup

This skill drives the Paperboy MCP server at `https://paperboyseo.com/mcp` (Streamable HTTP). If the `paperboy` tools are not available, set it up first. The key comes from the environment variable `PAPERBOY_API_KEY` (create one at https://paperboyseo.com/app/settings/api). The server also supports OAuth, so a client can sign in instead of using a key.

    claude mcp add --transport http paperboy https://paperboyseo.com/mcp --header "Authorization: Bearer $PAPERBOY_API_KEY"

Never write the key into a file in the project, and never print it.

## Tools

- `get_sites`: list sites. Free. Always start here to get the site id.
- `suggest_topics`: next articles to write, with the reason for each. Costs credits.
- `write_article`: start an article. Costs credits, returned if it fails. Returns an id at once.
- `get_article`: status, verdict and sources. Free. Poll every 30 seconds after `write_article` until the status is `published` or `needs_review`.
- `check_claims`: fact check a URL or pasted Markdown. Costs credits.
- `publish_article`: publish an article that passed.
- `schedule_article`: publish an article that passed at a later time.
- `get_performance`, `get_queries`, `get_site_report`: Search Console clicks, impressions, position, queries and a site summary. Reads.

Typical costs: `suggest_topics` 1 credit, `check_claims` 2 credits, `write_article` 12 credits. The tool descriptions are the source of truth if they differ.

## Rules

1. Say what a call costs before you make a spending call, and ask first when the user did not ask for it.
2. Never publish or schedule without the user's go-ahead. Leave `publish` at false in `write_article`, show the article and the verdict, then call `publish_article` or `schedule_article` only after they approve.
3. If the verdict has a failed check, show the flagged claims and their fixes. Do not publish around it.
4. If a call says `payment_required`, tell the user to add credits at https://paperboyseo.com/app/settings/api. Do not retry.
5. Reading data is free. Prefer `get_performance` before suggesting new topics.
6. On a 401, the key is missing or wrong. Ask the user to set `PAPERBOY_API_KEY`; do not ask them to paste it into the chat.
