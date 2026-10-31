// SPDX-License-Identifier: AGPL-3.0-only
// Release gate: fails if anything that must not be public is in the tree. Run by CI and before every push.
// The patterns are built from pieces so this file does not match itself.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const j = (...p) => p.join("");
const banned = [
  j("ki", "mi"), j("moon", "shot"), j("net", "lify\\.app"), j("riot", "digital"), j("sco", "ttwilder"),
  j("pick", "check"), j("get", "stash"), j("1811", "blueprint"), j("haul", "math"),
  j("glea", "son24"), j("hub_", "secret"), j("sk_", "live_"), j("sk-", "ant-"), j("whsec", "_[A-Za-z0-9]"),
];
const re = new RegExp(banned.join("|"), "i");
// House style: no em or en dashes in prose. Code may handle them (the style check looks for them), so only docs and config are checked.
const dash = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
// Generic lists that legitimately name a shared host.
const allow = { "packages/engine/src/config/serp-gate.ts": [j("net", "lify\\.app")] };
// Obvious test fixtures (11111111-1111-4111-8111-111111111111) are fine; real-looking ids are not.
const fakeUuid = /\b([0-9a-f])\1{7}-\1{4}-[1-5]\1{3}-[89ab]\1{3}-\1{12}\b/i;
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

const files = execSync("git ls-files -co --exclude-standard", { encoding: "utf8" }).split("\n").filter(Boolean)
  .filter((f) => !/(^|\/)(package-lock\.json|LICENSE|CODE_OF_CONDUCT\.md)$/.test(f) && !f.endsWith("scripts/scrub.mjs"));

let bad = 0;
for (const f of files) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    const skip = (allow[f] ?? []).some((a) => new RegExp(a, "i").test(line));
    const m = (skip ? null : line.match(re)) || (fakeUuid.test(line) ? null : line.match(uuid)) || (/\.(md|ya?ml|json)$/.test(f) ? line.match(dash) : null);
    if (m) { bad++; console.error(`${f}:${i + 1}: ${m[0]}`); }
  });
}
if (bad) { console.error(`\nscrub: ${bad} problem(s)`); process.exit(1); }
console.log(`scrub: clean (${files.length} files)`);
