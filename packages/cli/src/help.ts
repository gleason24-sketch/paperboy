export const HELP = `paperboy - the open-source growth engine from the command line

Usage: paperboy <command> [options]

Commands:
  connect [site-url]     Sign in (device flow) and optionally add a site + Search Console
  topics                 Pick topics worth writing, from Search Console data
  write                  Write, fact-check and (optionally) publish an article
  check <url|file.md>    Fact-check a page or a markdown file (exit 1 if it fails)
  publish <article-id>   Publish a drafted article
  status                 Show account, credits and site status
  report                 Search performance report for the site
  mcp                    Run an MCP server on stdio, so an AI agent can use these commands as tools

Global options:
  --json                 Print exactly one JSON object per command
  --site <id|domain>     Site to use (default: saved default, or your only site)
  --api-key <key>        API key (env PAPERBOY_API_KEY)
  --base-url <url>       API base URL (env PAPERBOY_BASE_URL, default https://paperboyseo.com)
  --no-color             Disable colored output (also honors NO_COLOR)
  -y, --yes              Do not ask for confirmation
  -h, --help             Show this help
  -v, --version          Show the version

Command options:
  connect  --self-host <url>  Use a self-hosted instance (saved as base_url)
           --api-key <key>    Skip the browser flow and save this key
           --no-wait          Print the Search Console link without waiting
           --no-open          Do not open the browser
  topics   -n, --n <count>    How many topics (default 5)
  write    --topic <id|text>  A topic id from \`paperboy topics\`, or free text in quotes
           --publish          Publish when the fact-check passes
           --wait / --no-wait Wait for the job (default: wait on a terminal)
  check    --sources <file>   Extra source URLs or notes, one per line
  report   --days <n>         Window in days (default 28)
           --markdown         Render a markdown report on the server

Exit codes: 0 ok, 1 fact-check failed (or nothing published), 2 error.
Docs: https://paperboyseo.com/docs/cli`;
