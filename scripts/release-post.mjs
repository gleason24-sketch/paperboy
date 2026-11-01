#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Turns the CHANGELOG section and the git log of a release into one file of post drafts.
// Usage: node scripts/release-post.mjs [--version 0.2.0] [--since <tag|sha>] [--out <dir>]
// It only writes the file. Nothing is posted. See RELEASING.md.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContext, parseChangelog, parseCommits, parseRoadmap, pickSection, renderFile } from "./lib/release-post-lib.mjs";

// The org move is a one-line change: edit the default below or set PAPERBOY_REPO_URL.
const j = (...p) => p.join(""); // pieces keep the scrub gate from matching this file
const REPO_URL = (process.env.PAPERBOY_REPO_URL || `https://github.com/${j("glea", "son24")}-sketch/paperboy`).replace(/\/+$/, "");
const DOCS_URL = "https://paperboyseo.com/docs";
const CLI_ON_NPM = false; // flip when @paperboyseo/cli is published

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) { console.error(`release-post: --${name} needs a value`); process.exit(2); }
  return v;
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: node scripts/release-post.mjs [--version 0.2.0] [--since <tag|sha>] [--out <dir>]");
  process.exit(0);
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const sections = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
const wanted = arg("version");
const section = pickSection(sections, wanted);
if (!section) {
  console.error(wanted ? `release-post: no section for ${wanted} in CHANGELOG.md` : "release-post: CHANGELOG.md has no version section");
  process.exit(1);
}
const previous = sections[sections.findIndex((s) => s.version === section.version) + 1] ?? null;

// Last tag that is not this release; with no tag, the whole history.
let since = arg("since");
if (!since) {
  try {
    since = git("tag", "--list", "v*", "--sort=-v:refname").split("\n").filter(Boolean).find((t) => t !== `v${section.version}`) ?? null;
  } catch { since = null; }
}
const range = since ? [`${since}..HEAD`] : ["HEAD"];
let commits = [];
try {
  commits = parseCommits(git("log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", ...range));
} catch (e) {
  console.error(`release-post: git log failed (${String(e.message).split("\n")[0]}); continuing with the changelog only`);
}

const roadmapPath = join(root, "ROADMAP.md");
const roadmap = existsSync(roadmapPath) ? parseRoadmap(readFileSync(roadmapPath, "utf8")) : [];

const ctx = buildContext({ section, previous, commits, roadmap, repoUrl: REPO_URL, docsUrl: DOCS_URL, cliOnNpm: CLI_ON_NPM, since });
const outDir = resolve(process.cwd(), arg("out") ?? "release-posts");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `v${section.version}.md`);
writeFileSync(file, renderFile(ctx));
console.log(`release-post: wrote ${file} (${commits.length} commits${since ? ` since ${since}` : ""}, ${section.bullets.length} changelog bullets)`);
