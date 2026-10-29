# Roadmap

Honest status: this is v0.1, an alpha. What works is listed in the README. What is next:

## Next

- [ ] First npm release of `@paperboyseo/cli` with provenance.
- [ ] MCP server (`packages/mcp`): the same tools as the CLI, over stdio first, then a remote HTTP endpoint.
- [ ] Agent files generated from one source: Claude Code plugin, OpenClaw skill, Cursor rule, Codex instructions.
- [ ] Typed SDK (`@paperboyseo/sdk`) generated from the OpenAPI document.
- [ ] A small web dashboard for self-host (today the interface is the CLI and the API).
- [ ] More publish adapters: Webflow, Framer, Shopify, Next.js snippet.
- [ ] Model-agnostic writing layer (today the engine uses Claude and its web search tool).

## Later

- [ ] Docker Hub image.
- [ ] Bundled auth profile so a self-host needs no external identity provider.
- [ ] Open crawler dataset and its updater.

Have an opinion? Open a feature request.
