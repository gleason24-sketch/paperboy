// SPDX-License-Identifier: AGPL-3.0-only
// Pure functions behind scripts/release-post.mjs: changelog parsing, commit grouping, dash scrub, and the six draft templates.
// Nothing here touches the disk, git or the network, so it can be tested directly.

// Written from pieces so the file itself holds no dash characters.
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const DASHES = new RegExp(`[${EM}${EN}]`);

export const DRAFTS_NOTE = "DRAFTS. Nothing here is posted. Check each community's self-promotion rules before posting.";

export const SECTION_IDS = ["github-release", "reddit-selfhosted", "devto", "indiehackers", "hackernoon", "lemmy-selfhosted"];

/** House style: no em or en dashes. A numeric range becomes a hyphen, anything else becomes a comma. */
export function scrubDashes(text) {
  return String(text)
    .replace(new RegExp(`(\\d)\\s*[${EM}${EN}]\\s*(\\d)`, "g"), "$1-$2")
    .replace(new RegExp(`\\s*[${EM}${EN}]\\s*`, "g"), ", ");
}

export function hasDash(text) {
  return DASHES.test(text);
}

/**
 * Split CHANGELOG.md into sections. A section starts at "## <version> (<date>)".
 * Optional lines inside a section: "Name: <release name>" and "Headline: <text of the headline bullet>".
 * Returns newest first, in file order.
 */
export function parseChangelog(markdown) {
  const sections = [];
  let cur = null;
  let last = null; // the bullet that a wrapped line continues
  for (const raw of String(markdown).split(/\r?\n/)) {
    const h = raw.match(/^##\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*(?:\((\d{4}-\d{2}-\d{2})\))?\s*$/);
    if (h) {
      cur = { version: h[1], date: h[2] ?? null, name: null, headline: null, notes: [], bullets: [] };
      sections.push(cur);
      last = null;
      continue;
    }
    if (!cur) continue;
    if (/^#{1,2}\s/.test(raw)) { cur = null; continue; }
    const meta = raw.match(/^(Name|Headline):\s*(.+)$/i);
    if (meta) { cur[meta[1].toLowerCase()] = meta[2].trim(); last = null; continue; }
    const b = raw.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (b) { last = b[1]; cur.bullets.push(last); continue; }
    if (/^\s+\S/.test(raw) && last !== null) {
      cur.bullets[cur.bullets.length - 1] += ` ${raw.trim()}`;
      last = cur.bullets[cur.bullets.length - 1];
      continue;
    }
    if (raw.trim()) { cur.notes.push(raw.trim()); last = null; } else last = null;
  }
  return sections;
}

export function pickSection(sections, version) {
  if (!sections.length) return null;
  if (!version) return sections[0];
  const v = version.replace(/^v/, "");
  return sections.find((s) => s.version === v) ?? null;
}

/** Split `git log --format=%H%x1f%s%x1f%b%x1e` output. Merges and Co-Authored-By lines are dropped. */
export function parseCommits(raw) {
  const out = [];
  for (const rec of String(raw).split("\x1e")) {
    const [sha, subject = "", body = ""] = rec.replace(/^\n+/, "").split("\x1f");
    if (!sha || !sha.trim()) continue;
    const s = subject.trim();
    if (!s || /^Merge\b/i.test(s)) continue;
    const bodyLines = body.split(/\r?\n/).filter((l) => !/^\s*co-authored-by:/i.test(l)).map((l) => l.trimEnd());
    out.push({ sha: sha.trim().slice(0, 7), subject: s, body: bodyLines.join("\n").trim() });
  }
  return out;
}

const PREFIX_KIND = { feat: "feat", feature: "feat", fix: "fix", bugfix: "fix", docs: "docs", doc: "docs" };

/** Kind of one commit: conventional prefix first, then keywords in the subject. */
export function classifyCommit(subject) {
  const p = subject.match(/^(\w+)(?:\([^)]*\))?!?:\s/);
  if (p) return PREFIX_KIND[p[1].toLowerCase()] ?? "other";
  // Anchored on the first words: "align docs" or "self-host fixes" later in a long subject must not decide the group.
  if (/^(fix|fixes|fixed|bugfix|patch|hotfix)\b/i.test(subject)) return "fix";
  if (/^(docs?|readme|changelog|document|documentation|update (the )?(readme|docs|changelog))\b/i.test(subject)) return "docs";
  if (/^(add|adds|added|new|support|introduce|implement)\b/i.test(subject)) return "feat";
  return "other";
}

export const GROUP_TITLES = { feat: "Features", fix: "Fixes", docs: "Docs", other: "Other" };

export function groupCommits(commits) {
  const groups = { feat: [], fix: [], docs: [], other: [] };
  for (const c of commits) {
    const kind = classifyCommit(c.subject);
    groups[kind].push({ ...c, title: c.subject.replace(/^\w+(?:\([^)]*\))?!?:\s+/, "") });
  }
  return groups;
}

/** Unchecked items of ROADMAP.md, in order. */
export function parseRoadmap(markdown) {
  return String(markdown).split(/\r?\n/).map((l) => l.match(/^-\s+\[ \]\s+(.*\S)\s*$/)?.[1]).filter(Boolean);
}

// ---- bullet helpers -------------------------------------------------------------------------

const unTick = (s) => s.replace(/`/g, "");
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const plain = (s) => unTick(s).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

/** The part before the first colon when it is short, else the first few words. */
export function leadOf(text) {
  const m = text.match(/^([^:]{3,60}):\s/);
  if (m) return m[1];
  return text.split(/\s+/).slice(0, 8).join(" ");
}

export function bodyOf(text) {
  const m = text.match(/^[^:]{3,60}:\s+(.*)$/);
  return m ? m[1] : text;
}

export function firstSentence(text) {
  const m = text.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : text).replace(/[.]$/, "");
}

const KIND_RULES = [
  ["factcheck", /fact.?check|judge|verif/i],
  ["agent", /\bcli\b|\bmcp\b|--json|^`?paperboy[ `]|@paperboyseo/i],
  ["selfhost", /self-?host|docker|compose|postgres|PAPERBOY_|migrat|worker|server/i],
  ["loop", /search console|rank loop|topic|gsc/i],
];

/** Classify a bullet by its lead (the text before the colon) so a long bullet that merely mentions a word is not misfiled. */
export function bulletKind(text) {
  const lead = text.match(/^([^:]{3,60}):\s/)?.[1] ?? text.slice(0, 60);
  for (const [kind, re] of KIND_RULES) if (re.test(lead)) return kind;
  return "other";
}

const HEADLINE_PRIORITY = [/fact.?check/i, /search console|rank loop/i, /\bmcp\b/i, /self-?host|docker/i];

/** The bullet to build the walk-through around: the "Headline:" line, else a keyword match on the lead, else the first bullet. */
export function pickHeadline(section) {
  if (section.headline) {
    const m = section.bullets.find((b) => b.toLowerCase().includes(section.headline.toLowerCase()));
    return m ?? section.headline;
  }
  for (const re of HEADLINE_PRIORITY) {
    const m = section.bullets.find((b) => re.test(b.match(/^([^:]{3,60}):\s/)?.[1] ?? b.slice(0, 60)));
    if (m) return m;
  }
  return section.bullets[0] ?? "";
}

const TOPIC = {
  factcheck: ["checking every claim against its saved source", "that checks every claim against its saved source"],
  loop: ["the Search Console loop", "with a Search Console feedback loop"],
  agent: ["driving it from an AI agent", "you can drive from an AI agent"],
  selfhost: ["running it yourself with Docker Compose", "you can run with one docker compose up"],
};

/** Everything the templates need, derived once. */
export function buildContext({ section, previous = null, commits = [], roadmap = [], repoUrl, docsUrl, cliOnNpm = false, since = null }) {
  const version = section.version;
  const headline = pickHeadline(section);
  const kind = bulletKind(headline);
  const lead = leadOf(headline);
  const topic = TOPIC[kind]?.[0] ?? lowerFirst(plain(lead));
  const blurb = TOPIC[kind]?.[1] ?? `with ${topic}`;
  const first = !previous;
  const bullets = section.bullets.map((text) => ({ text, kind: bulletKind(text) }));
  const preRelease = /^0\./.test(version);
  const name = section.name ?? (first ? "First public release" : plain(lead));
  const repoBlob = (p) => `${repoUrl}/blob/HEAD/${p}`;
  return {
    version, tag: `v${version}`, date: section.date, name, headline, headlineKind: kind, headlineLead: lead, topic, blurb,
    first, preRelease, bullets, commits, groups: groupCommits(commits), roadmap, since,
    upgradeBullets: section.bullets.filter((b) => /migrat|renumber|breaking|renamed|default|upgrade/i.test(b)),
    cliOnNpm, links: {
      repo: repoUrl, docs: docsUrl, hostedMcp: "https://paperboyseo.com/mcp", cloud: "https://paperboyseo.com",
      changelog: repoBlob("CHANGELOG.md"), release: `${repoUrl}/releases/tag/v${version}`,
      selfHostDoc: repoBlob("docs/self-host.md"), factCheckDoc: repoBlob("docs/fact-check.md"),
      mcpDoc: repoBlob("docs/mcp.md"), roadmap: repoBlob("ROADMAP.md"), issues: `${repoUrl}/issues`,
    },
  };
}

const list = (items) => items.map((t) => `- ${t}`).join("\n");
const bl = (bullets) => list(bullets.map((b) => b.text));

function cliInstall(ctx) {
  const lines = ctx.cliOnNpm
    ? ["npm install -g @paperboyseo/cli"]
    : ["npm ci --prefix packages/cli && npm run build --prefix packages/cli", 'alias paperboy="node $PWD/packages/cli/dist/cli.js"'];
  return [...lines, "paperboy connect https://your-site.com --self-host http://localhost:3000", "paperboy check https://your-site.com/some-article   # needs no Anthropic key"].join("\n");
}

const CLONE = (ctx) => `git clone ${ctx.links.repo}.git && cd paperboy\ncp .env.example .env  # set ANTHROPIC_API_KEY, the passwords, PAPERBOY_ADMIN_EMAIL, PAPERBOY_ADMIN_PASSWORD\ndocker compose up --build`;

const cliLine = (ctx) => (ctx.cliOnNpm ? "The CLI is on npm as `@paperboyseo/cli`." : "The CLI is not on npm yet, so you run it from source (Node 22 or newer).");
const stage = (ctx) => (ctx.preRelease ? "It is alpha software: expect rough edges, and expect the API and schema to change before 1.0." : "");

const FACT_STEPS = [
  "**The sources are saved, not remembered.** While researching, Paperboy reads up to 6 pages and stores the text of each one (up to 24,000 characters per page). Every later check runs against those stored texts.",
  "**Rule checks run first and need no model.** A number in a cited sentence must appear in the text of the page it links. A link must point at a page that was actually read. Banned claims are matched exactly.",
  "**Then a judge** reads each cited sentence next to the passages of its source that overlap it most and answers supported, partly supported or not supported. With an Anthropic key the judge is Claude Haiku 4.5. Without one it falls back to `RuleJudge`, a deterministic word-overlap score.",
  "**The verdict is arithmetic.** Each blocking issue costs 12 points and each warning 2 (capped at 20). An article passes with no blocking issue and a score of at least 70. Every issue carries the quoted sentence, the problem and the fix.",
  "**It fails closed.** A failing article gets one fix pass on the flagged paragraphs, then the whole check runs again. If it still fails, the article is held for review and never published automatically.",
];

const LIMITS = (ctx) => [
  ...(ctx.preRelease ? ["Alpha. Expect rough edges and API or schema changes before 1.0."] : []),
  ...(ctx.cliOnNpm ? [] : ["The CLI is not on npm yet. Run it from source."]),
  "No web dashboard or hosted blog in the repository: on a self-host you publish to WordPress, Ghost or a signed webhook. The dashboard and the hosted blog are part of the paid Cloud.",
  "The fact check can tell whether an article says what its source says. It cannot tell whether the source is right. The open `RuleJudge` is a word-overlap baseline and will accept a paraphrase that reuses the source's wording.",
  "Writing uses Claude and its web search tool. There is no model-agnostic layer yet.",
  "Search Console on a self-host needs your own Google OAuth client.",
];

const DISCLOSURE = (ctx) =>
  `Disclosure: I build Paperboy. This repository is the free, AGPL-3.0 engine; there is also a paid hosted version at ${ctx.links.cloud}.`;

// ---- the six drafts --------------------------------------------------------------------------

export function renderGithubRelease(ctx) {
  const g = ctx.groups;
  const commitLines = (arr) => arr.map((c) => `- ${c.title} (${c.sha})`).join("\n");
  const commitBlock = ["feat", "fix", "docs", "other"].filter((k) => g[k].length)
    .map((k) => `### ${GROUP_TITLES[k]}\n\n${commitLines(g[k].slice(0, 15))}`).join("\n\n");
  const upgrade = ctx.first
    ? "There is nothing to upgrade from: this is the first release."
    : `Back up the database first, then pull and restart. The migrate job applies new migrations on start.\n\n\`\`\`bash\ndocker compose exec db pg_dump -U postgres paperboy > backup.sql\ngit pull\ndocker compose up --build -d\n\`\`\`${ctx.upgradeBullets.length ? `\n\nWorth reading before you upgrade:\n\n${list(ctx.upgradeBullets)}` : ""}`;
  return {
    title: `${ctx.tag}: ${ctx.name}`,
    body: `## What is new

${bl(ctx.bullets)}

${commitBlock ? `<details>\n<summary>Changes by type (${ctx.commits.length} commits)</summary>\n\n${commitBlock}\n\n</details>\n\n` : ""}## Upgrade notes

${upgrade}

${cliLine(ctx)} ${stage(ctx)}`.trim() + `

## Links

- Full changelog: ${ctx.links.changelog}
- Self-host guide: ${ctx.links.selfHostDoc}
- Docs: ${ctx.links.docs}
`,
  };
}

export function renderReddit(ctx) {
  const selfhost = ctx.bullets.filter((b) => b.kind === "selfhost");
  const rest = ctx.bullets.filter((b) => b.kind !== "selfhost");
  return {
    title: `[Release] Paperboy ${ctx.tag}: self-hosted SEO article engine ${ctx.blurb} (AGPL-3.0, Docker Compose, your own keys)`,
    body: `${DISCLOSURE(ctx)}

Paperboy reads your Google Search Console, picks a topic you can rank for, researches it, writes the article, checks the draft against the source text it saved while researching, and publishes to WordPress, Ghost or a webhook. ${ctx.tag} is out${ctx.date ? ` (${ctx.date})` : ""}.

**Self-host first**

\`docker compose up --build\` starts four things:

- \`db\`: Postgres 16 with a named volume.
- \`migrate\`: runs on every start, applies new migrations, sets the app role's password and creates your operator account.
- \`web\`: the API server on port 3000.
- \`worker\`: the timers (scheduled articles, the daily Search Console pull, the weekly report, the rank loop).

You bring your own Anthropic key and your own Postgres (a bundled one is in the compose file). The worker's schedule is off by default (\`PAPERBOY_ARTICLES_PER_WEEK=0\`), so nothing is spent until you run \`paperboy write\`, and a passed article waits for your \`paperboy publish\`. Without a key only \`paperboy check\` works, using the word-overlap \`RuleJudge\`.

What leaves your machine: calls to the Anthropic API (research, writing, the model judge), the web pages it fetches while researching, Search Console if you connect it, and your publish target. The hosted verifier is only used if you set \`PAPERBOY_VERIFIER=hosted\`.

**What is in ${ctx.tag}**

${selfhost.length ? `Self-host and database:\n\n${bl(selfhost)}\n\n` : ""}${rest.length ? `${selfhost.length ? "Engine, CLI and agents:\n\n" : ""}${bl(rest)}\n\n` : ""}**Limits, so you do not find them the hard way**

${list(LIMITS(ctx))}

**Try it**

\`\`\`bash
${CLONE(ctx)}

${cliInstall(ctx)}
\`\`\`

Repo: ${ctx.links.repo}
Docs: ${ctx.links.docs}
Changelog: ${ctx.links.changelog}

The most useful feedback right now is on the compose setup and the \`.env\` defaults. What would you change first?`,
  };
}

export function renderDevto(ctx) {
  const fact = ctx.headlineKind === "factcheck";
  const walk = fact
    ? `## How the check works

The idea is simple: the engine should never publish a claim it could not compare with a page it actually read. In ${ctx.tag} the whole thing is code you can read (\`packages/engine/src/lib/quality\`).

${FACT_STEPS.map((s, i) => `${i + 1}. ${s}`).join("\n")}

### Run it on anything

You do not need a Paperboy article to use the check. It exits 0 on a pass and 1 on a hold, so it fits in CI:

\`\`\`bash
paperboy check draft.md
paperboy check https://example.com/blog/post
\`\`\`

### What it does not do

It compares the article with the source, not the source with the world. A wrong source gives a confidently verified wrong claim. The open \`RuleJudge\` can also accept a paraphrase that reuses the source's words, which is why the model judge exists.`
    : `## The headline change

${bodyOf(ctx.headline)}

Detail for this feature is in the [changelog](${ctx.links.changelog}) and the [docs](${ctx.links.docs}).`;
  return {
    title: `A walkthrough of ${ctx.topic} in an open-source SEO tool`,
    body: `---
title: "A walkthrough of ${ctx.topic} in an open-source SEO tool"
published: false
description: "What changed in Paperboy ${ctx.tag} and how it works, from the code."
tags: opensource, selfhosted, seo, node
---

I build Paperboy, an AGPL-3.0 engine that researches, writes, fact-checks and publishes SEO articles using your Search Console data. This post walks through ${ctx.topic}, the main change in ${ctx.tag}. If you only want to try it, jump to the end.

${walk}

## The rest of ${ctx.tag}

${bl(ctx.bullets.filter((b) => b.text !== ctx.headline))}

## Running it

Docker and an Anthropic key are enough:

\`\`\`bash
${CLONE(ctx)}
\`\`\`

${cliLine(ctx)}

\`\`\`bash
${cliInstall(ctx)}
\`\`\`

## Where it stands

${list(LIMITS(ctx))}

Code: ${ctx.links.repo}
Docs: ${ctx.links.docs}
`,
  };
}

export function renderIndieHackers(ctx) {
  const next = ctx.roadmap.slice(0, 2);
  const short = (t) => plain(t).split(/[:,]/)[0].trim();
  const q = next.length === 2
    ? `If you had to pick one, which would you want first: "${short(next[0])}" or "${short(next[1])}"?`
    : "What would make you trust a tool like this enough to let it publish on its own?";
  return {
    title: `What I shipped in Paperboy ${ctx.tag}, and what I am still unsure about`,
    body: `Short build log for ${ctx.tag}${ctx.date ? ` (${ctx.date})` : ""}. ${DISCLOSURE(ctx)}

**Why this release exists**

${ctx.first
  ? "This is the first public cut: the core loop is now open, so you can read it, run it and tell me where it is wrong. The loop: pick a topic from Search Console data, research it, write it, check every claim against the saved source, publish, then learn from what Search Console shows."
  : `The main goal was ${ctx.topic}. The rest is the usual cleanup that piles up in a week.`}

**What shipped**

${bl(ctx.bullets)}

**What I would do differently**

${ctx.first ? "I parked the CI workflows in a folder because the token that created the repository could not push workflow files. So pull requests are not checked automatically yet; I run typecheck and tests by hand until that is fixed." : "Nothing dramatic this time, but the limits below are real and I would rather you hear them from me."}

**Honest limits**

${list(LIMITS(ctx))}

**What is next**

${next.length ? list(next.map(plain)) : `See the roadmap: ${ctx.links.roadmap}`}

${q} Repo is ${ctx.links.repo} if you want to look.`,
  };
}

export function renderHackernoon(ctx) {
  const fact = ctx.headlineKind === "factcheck";
  return {
    title: fact
      ? "Why My Open-Source SEO Writer Holds Back Articles It Cannot Verify"
      : `Notes From Shipping Paperboy ${ctx.tag}: ${ctx.name}`,
    body: `**TL;DR**

${list([
  `Paperboy ${ctx.tag} is an open-source (AGPL-3.0) engine that researches, writes, fact-checks and publishes SEO articles.`,
  fact ? "Every cited claim is compared with the exact page text saved during research. An article that still fails after one fix pass is held, not published." : `The main change is ${ctx.topic}.`,
  "You can self-host it with Docker Compose and your own Anthropic key.",
  ctx.preRelease ? "It is alpha, and the post says where it is weak." : "Known limits are listed below.",
])}

*${DISCLOSURE(ctx)}*

## The problem

AI writing tools are good at producing a plausible article. They are much worse at telling you which sentence in it is unsupported. If the tool also publishes on a schedule, a bad sentence reaches your site before anyone reads it.

## The approach

${fact
  ? `Paperboy treats the draft as something to be audited. While researching it stores the text of every page it reads, and the check later runs against those stored texts instead of the model's memory.\n\n${FACT_STEPS.map((s) => `- ${s}`).join("\n")}`
  : `${bodyOf(ctx.headline)}\n\nThe loop around it stays the same: topic, research, write, check, publish, measure.`}

## What ${ctx.tag} adds

${bl(ctx.bullets)}

## What is still weak

${list(LIMITS(ctx))}

## Try it, or break it

\`\`\`bash
${CLONE(ctx)}
\`\`\`

${cliLine(ctx)} The hosted MCP server, if you would rather point an AI agent at a managed instance, is at ${ctx.links.hostedMcp}.

Code and issues: ${ctx.links.repo}. Docs: ${ctx.links.docs}.`,
  };
}

export function renderLemmy(ctx) {
  // The headline, then the first bullet of each other kind, so the short list is not five bullets about one thing.
  const top = [ctx.bullets.find((b) => b.text === ctx.headline)].filter(Boolean);
  for (const b of ctx.bullets) if (top.length < 4 && !top.some((t) => t.kind === b.kind) && !/^first\b/i.test(b.text)) top.push(b);
  return {
    title: `Paperboy ${ctx.tag}: self-hosted SEO article engine (AGPL-3.0, Docker Compose)`,
    body: `Repo: ${ctx.links.repo}
Release: ${ctx.links.release}
Docs: ${ctx.links.docs}

${ctx.tag} of Paperboy is out. It runs in Docker Compose (Postgres, a migrate job, an API server and a worker) with your own Anthropic key, and checks each article against its saved sources before publishing.

${bl(top)}${ctx.bullets.length > top.length ? `\n- and ${ctx.bullets.length - top.length} more in the [changelog](${ctx.links.changelog})` : ""}

${ctx.preRelease ? "Alpha. " : ""}${cliLine(ctx)}

${DISCLOSURE(ctx)}`,
  };
}

const SECTIONS = [
  ["github-release", "GitHub Release notes", renderGithubRelease, "Paste into the release body for the tag."],
  ["reddit-selfhosted", "r/selfhosted post", renderReddit, "Use the flair and self-promotion rules of the sub. Keep the disclosure line."],
  ["devto", "dev.to article draft", renderDevto, "Frontmatter is included with published: false."],
  ["indiehackers", "Indie Hackers post", renderIndieHackers, "Builder story; the last line is a question to the community."],
  ["hackernoon", "Hackernoon draft", renderHackernoon, "Story-style article with a TL;DR."],
  ["lemmy-selfhosted", "Lemmy post (selfhosted community)", renderLemmy, "Short and link-first."],
];

/** The six drafts as { id, heading, hint, title, body }. Every string is dash-scrubbed. */
export function renderDrafts(ctx) {
  return SECTIONS.map(([id, heading, fn, hint]) => {
    const d = fn(ctx);
    return { id, heading, hint, title: scrubDashes(d.title), body: scrubDashes(d.body) };
  });
}

/** The single output file. */
export function renderFile(ctx) {
  const drafts = renderDrafts(ctx);
  const head = `# Release drafts for Paperboy ${ctx.tag}

> ${DRAFTS_NOTE}

Generated from CHANGELOG.md${ctx.since ? ` and the git commits since ${ctx.since}` : " and the git history"}. Workflow: RELEASING.md. One community per day, always say you are the maker.
`;
  const parts = drafts.map((d, i) => `<!-- BEGIN ${d.id} -->
---

## Draft ${i + 1} of ${drafts.length}: ${d.heading}

*${d.hint}*

**Title:** ${d.title}

\`\`\`\`markdown
${d.body}
\`\`\`\`

<!-- END ${d.id} -->`);
  return scrubDashes(`${head}\n${parts.join("\n\n")}\n`).replace(/\n{3,}/g, "\n\n");
}
