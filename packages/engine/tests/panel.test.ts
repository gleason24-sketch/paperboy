import { describe, expect, it } from "vitest";
import { countClaims, panelFromVerdict } from "@/lib/quality/panel";
import type { CheckResult } from "@/lib/quality/types";

const pass = (id: CheckResult["id"], label: string, detail?: string): CheckResult => ({ id, label, pass: true, issues: [], method: "rules", detail });
const body = [
  "Google says AI features follow the same rules as search ([Google](https://developers.google.com/search/docs/appearance/ai-features)).",
  "This sentence has no link at all.",
  "Reports show 40 percent growth ([Example](https://example.com/report)).",
].join("\n\n");

describe("fact-check panel data", () => {
  it("counts cited sentences as the claims that were checked", () => {
    expect(countClaims(body, [pass("made_up_stats", "Numbers match their sources")])).toEqual({ total: 2, checked: 2 });
  });

  it("does not count a claim a blocking issue quotes", () => {
    const held: CheckResult = { id: "made_up_stats", label: "Numbers match their sources", pass: false, method: "rules", issues: [{ quote: "Reports show 40 percent growth", problem: "40 does not appear in the source", fix: "", severity: "block" }] };
    expect(countClaims(body, [held])).toEqual({ total: 2, checked: 1 });
  });

  it("maps checks, sources and notes without inventing anything", () => {
    const p = panelFromVerdict(
      { score: 96, pass: true, created_at: "2026-10-28T05:02:51Z", checks: [pass("made_up_stats", "Numbers match their sources", "Every number in a cited sentence was looked up in the saved source text.")] },
      { title: "T", bodyMarkdown: body, sources: [{ url: "https://www.example.com/a", selling: true }, { url: "not a url" }] },
    );
    expect(p.checks).toEqual([{ id: "made_up_stats", label: "Numbers match their sources", state: "pass", detail: "Every number in a cited sentence was looked up in the saved source text." }]);
    expect(p.sources).toEqual([{ host: "example.com", selling: true }]);
    expect(p.sourcesRead).toBe(1);
    expect(p.passed).toBe(true);
    expect(p.checkedOn).toBe("2026-10-28T05:02:51.000Z");
  });

  it("states a held check as a count of items, not model prose", () => {
    const held: CheckResult = { id: "citation_mismatch", label: "Sources say what the article says", pass: false, method: "model", issues: [{ quote: "q", problem: "long model prose", fix: "", severity: "block" }, { quote: "r", problem: "x", fix: "", severity: "block" }] };
    expect(panelFromVerdict({ score: 55, pass: false, checks: [held] }, { title: "T" }).checks[0]).toMatchObject({ state: "held", detail: "2 items held for a fix" });
  });
});
