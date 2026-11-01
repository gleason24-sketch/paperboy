// SPDX-License-Identifier: AGPL-3.0-only
// Run with: node --test scripts/test (wired into `npm test`). Plain node:test, no dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DRAFTS_NOTE, SECTION_IDS, buildContext, classifyCommit, groupCommits, hasDash, parseChangelog, parseCommits, pickSection,
  renderDrafts, renderFile, scrubDashes,
} from "../lib/release-post-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

const ctxFor = (extra = {}) => {
  const sections = parseChangelog(changelog);
  return buildContext({
    section: pickSection(sections, "0.1.0"), previous: null, repoUrl: "https://github.com/example/paperboy", docsUrl: "https://paperboyseo.com/docs",
    roadmap: ["First roadmap item", "Second roadmap item"], ...extra,
  });
};

test("parses the real CHANGELOG 0.1.0 section", () => {
  const s = pickSection(parseChangelog(changelog), "0.1.0");
  assert.equal(s.version, "0.1.0");
  assert.equal(s.date, "2026-10-31");
  assert.ok(s.bullets.length >= 10);
  assert.ok(s.bullets.some((b) => b.startsWith("Fact check:")));
  assert.equal(pickSection(parseChangelog(changelog), null).version, parseChangelog(changelog)[0].version);
  assert.equal(pickSection(parseChangelog(changelog), "9.9.9"), null);
});

test("parses several sections, wrapped bullets and Name/Headline lines", () => {
  const md = "# Changelog\n\n## 0.2.0 (2026-11-03)\n\nName: Search Console loop\nHeadline: rank loop\n\n- Rank loop: reads\n  clicks daily.\n- Other thing\n\n## 0.1.0 (2026-10-31)\n\n- First\n";
  const [a, b] = parseChangelog(md);
  assert.equal(a.version, "0.2.0");
  assert.equal(a.name, "Search Console loop");
  assert.equal(a.bullets[0], "Rank loop: reads clicks daily.");
  assert.equal(b.bullets.length, 1);
});

test("parses commits: merges and Co-Authored-By lines are dropped", () => {
  const raw = [
    "aaaaaaa1\x1ffeat: add thing\x1fBody line\n\nCo-Authored-By: X <x@example.com>\x1e",
    "bbbbbbb2\x1fMerge pull request #4 from a/b\x1fx\x1e",
    "ccccccc3\x1ffix(api): handle empty\x1f\x1e",
  ].join("\n");
  const c = parseCommits(raw);
  assert.equal(c.length, 2);
  assert.equal(c[0].sha, "aaaaaaa");
  assert.ok(!/co-authored/i.test(c[0].body));
});

test("groups commits by prefix and keywords", () => {
  assert.equal(classifyCommit("feat: add x"), "feat");
  assert.equal(classifyCommit("fix(db): y"), "fix");
  assert.equal(classifyCommit("docs: z"), "docs");
  assert.equal(classifyCommit("chore: bump"), "other");
  assert.equal(classifyCommit("Fix crash on start"), "fix");
  assert.equal(classifyCommit("Update README"), "docs");
  assert.equal(classifyCommit("Add self-host API server"), "feat");
  assert.equal(classifyCommit("Rename things"), "other");
  assert.equal(classifyCommit("Launch polish: README, self-host fixes, MCP"), "other");
  assert.equal(classifyCommit("Add self-host server; align docs"), "feat");
  const g = groupCommits([{ sha: "1", subject: "feat: a b", body: "" }, { sha: "2", subject: "Rename things", body: "" }]);
  assert.equal(g.feat[0].title, "a b");
  assert.equal(g.other.length, 1);
});

test("scrubDashes removes em and en dashes", () => {
  const out = scrubDashes(`one ${EM} two, 3${EN}5 and a${EN}b`);
  assert.ok(!hasDash(out));
  assert.equal(out, "one, two, 3-5 and a, b");
});

test("renders six distinct sections, none with a dash, the note on top", () => {
  const ctx = ctxFor();
  const drafts = renderDrafts(ctx);
  assert.deepEqual(drafts.map((d) => d.id), SECTION_IDS);
  assert.equal(new Set(drafts.map((d) => d.title)).size, 6);
  assert.equal(new Set(drafts.map((d) => d.body)).size, 6);
  assert.equal(new Set(drafts.map((d) => d.body.slice(0, 80))).size, 6, "openings differ");
  const file = renderFile(ctx);
  assert.ok(file.includes(`> ${DRAFTS_NOTE}`));
  assert.ok(file.indexOf(DRAFTS_NOTE) < file.indexOf("BEGIN github-release"));
  for (const id of SECTION_IDS) {
    assert.equal(file.split(`<!-- BEGIN ${id} -->`).length, 2, id);
    assert.equal(file.split(`<!-- END ${id} -->`).length, 2, id);
  }
  assert.ok(!hasDash(file));
});

test("dashes in the changelog and commits never reach the output", () => {
  const section = { version: "0.2.0", date: "2026-11-03", name: null, headline: null, notes: [], bullets: [`Fact check: stricter ${EM} and faster`, `Range 2${EN}4 items`] };
  const commits = [{ sha: "abc1234", subject: `feat: thing ${EM} more`, body: "" }];
  const file = renderFile(buildContext({ section, previous: { version: "0.1.0" }, commits, roadmap: [], repoUrl: "https://github.com/example/paperboy", docsUrl: "https://paperboyseo.com/docs" }));
  assert.ok(!hasDash(file));
  assert.ok(file.includes("Upgrade notes"));
});

test("honest content: maker disclosure, run from source, hosted MCP, no invented numbers", () => {
  const drafts = Object.fromEntries(renderDrafts(ctxFor()).map((d) => [d.id, d]));
  for (const id of ["reddit-selfhosted", "indiehackers", "lemmy-selfhosted", "hackernoon"]) assert.match(drafts[id].body, /I build Paperboy/, id);
  assert.match(drafts["reddit-selfhosted"].body, /from source/);
  assert.match(drafts["hackernoon"].body, /https:\/\/paperboyseo\.com\/mcp/);
  assert.match(drafts["devto"].body, /published: false/);
  assert.match(drafts["devto"].body, /^---\ntitle:/);
  assert.match(drafts["hackernoon"].body, /TL;DR/);
  assert.match(drafts["indiehackers"].body, /\?\s*Repo is/);
  const all = Object.values(drafts).map((d) => d.body).join("\n");
  assert.ok(!/\b(stars|downloads|users|customers)\b/i.test(all.replace(/for your own users/g, "")), "no metrics words");
});
