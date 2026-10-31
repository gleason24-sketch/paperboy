# Roadmap

Honest status: this is v0.1, an alpha. What works is listed in the [README](README.md). What is next, roughly in order:

- [ ] Publish `@paperboyseo/cli` to npm with provenance, so `npx` works.
- [ ] Agent files generated from one source: Claude Code plugin, OpenClaw skill, Cursor rule, Codex instructions.
- [ ] Typed SDK (`@paperboyseo/sdk`) generated from the OpenAPI document.
- [ ] A small web dashboard for self-host, which also serves a hosted blog (today the interface is the CLI and the API).
- [ ] More publish adapters: Webflow, Framer, Shopify, Next.js snippet.
- [ ] Model-agnostic writing layer (today the engine uses Claude and its web search tool).
- [ ] A better open judge for the fact check than word overlap, for people who run without a model key.
- [ ] Docker Hub image.
- [ ] Bundled auth profile so a self-host needs no external identity provider.
- [ ] Open crawler dataset and its updater.

Done: the open fact check, Docker self-host with automatic migrations, the REST API, the CLI, and the stdio MCP server (`paperboy mcp`).

Have an opinion? Open a feature request.
