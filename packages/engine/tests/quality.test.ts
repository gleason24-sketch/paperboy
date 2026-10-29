import { describe, expect, it } from "vitest";
import { checkArticle, findNumbers, numberInText, sentences } from "@/lib/quality";
import { ruleChecks } from "@/lib/quality";
import type { Judge } from "@/lib/quality";

describe("numbers", () => {
  it("finds the numbers worth checking", () => {
    expect(findNumbers("About 45% of 1,200 owners paid $2.65 in 2024, in 3 steps.")).toEqual(["45%", "1,200", "$2.65"]);
  });
  it("matches formatting differences against the source", () => {
    const src = "In 2024, 45 percent of the 1200 owners we surveyed paid $2.65 per mile.";
    expect(numberInText("45%", src)).toBe(true);
    expect(numberInText("1,200", src)).toBe(true);
    expect(numberInText("$2.65", src)).toBe(true);
    expect(numberInText("2024", src)).toBe(true);
    expect(numberInText("46%", src)).toBe(false);
    expect(numberInText("12", src)).toBe(false); // must not match inside 1200
  });
});

describe("sentences", () => {
  it("keeps links attached to their sentence and tracks sections", () => {
    const md = "First answer here. See [the guide](https://x.com/a.b).\n\n## Costs\n\n- It costs [$40](https://y.com/p) a month.";
    const s = sentences(md);
    expect(s.map((x) => x.links)).toEqual([[], ["https://x.com/a.b"], ["https://y.com/p"]]);
    expect(s[2].section).toBe("Costs");
    expect(s[2].numbers).toEqual(["$40"]);
  });
  it("marks labeled examples and opinions", () => {
    const s = sentences("Say a 700-mile load at $2.65 a mile. My take: this is the best way.");
    expect(s[0].isExample).toBe(true);
    expect(s[1].isOpinion).toBe(true);
  });
});

const sources = [
  { url: "https://gov.example/rules", text: "Carriers must keep logs for 6 months, or 180 days. The fee is $85 per year.", selling: false },
  { url: "https://vendor.example/blog", text: "Our app costs $20 a month and saves 3 hours a week.", selling: true },
];

describe("rule checks against saved source text", () => {
  it("flags a number that is not in the linked source", () => {
    const md = "The fee is [$95 per year](https://gov.example/rules).";
    const r = ruleChecks({ article: { title: "T", bodyMarkdown: md }, sources }, sentences(md));
    expect(r.stats).toHaveLength(1);
    expect(r.stats[0].problem).toContain("$95");
  });
  it("passes a number that is in the linked source", () => {
    const md = "The fee is [$85 per year](https://gov.example/rules).";
    const r = ruleChecks({ article: { title: "T", bodyMarkdown: md }, sources }, sentences(md));
    expect(r.stats).toHaveLength(0);
  });
  it("accepts a number sourced by a link elsewhere in the same paragraph, only if that source has it", () => {
    const ok = "Keep logs for 180 days. That is the [federal rule](https://gov.example/rules).";
    expect(ruleChecks({ article: { title: "T", bodyMarkdown: ok }, sources }, sentences(ok)).stats).toHaveLength(0);
    const bad = "Keep logs for 190 days. That is the [federal rule](https://gov.example/rules).";
    expect(ruleChecks({ article: { title: "T", bodyMarkdown: bad }, sources }, sentences(bad)).stats).toHaveLength(1);
    const otherPara = "Keep logs for 180 days.\n\nThat is the [federal rule](https://gov.example/rules).";
    expect(ruleChecks({ article: { title: "T", bodyMarkdown: otherPara }, sources }, sentences(otherPara)).stats).toHaveLength(1);
  });
  it("lets table rows and list items rest on the link in the sentence that introduces them, if that source has the number", () => {
    const table = "Prices are from the [fee page](https://gov.example/rules).\n\n| Item | Cost |\n|---|---|\n| Annual fee | $85 per year |\n| Logs | 180 days |";
    expect(ruleChecks({ article: { title: "T", bodyMarkdown: table }, sources }, sentences(table)).stats).toHaveLength(0);
    const list = "Prices are from the [fee page](https://gov.example/rules).\n\n- The annual fee is $85.\n- The late fee is $95.";
    const r = ruleChecks({ article: { title: "T", bodyMarkdown: list }, sources }, sentences(list));
    expect(r.stats).toHaveLength(1);
    expect(r.stats[0].problem).toContain("$95");
    const noLead = "| Item | Cost |\n|---|---|\n| Annual fee | $85 per year |";
    expect(ruleChecks({ article: { title: "T", bodyMarkdown: noLead }, sources }, sentences(noLead)).stats).toHaveLength(1);
    const otherSection = "Prices are from the [fee page](https://gov.example/rules).\n\n## Later\n\n| Item | Cost |\n|---|---|\n| Annual fee | $85 per year |";
    expect(ruleChecks({ article: { title: "T", bodyMarkdown: otherSection }, sources }, sentences(otherSection)).stats).toHaveLength(1);
  });
  it("flags numbers with no source and links to pages that were never read", () => {
    const md = "Most owners spend 40% more.\n\nSee [this](https://random.example/x).";
    const r = ruleChecks({ article: { title: "T", bodyMarkdown: md }, sources }, sentences(md));
    expect(r.stats).toHaveLength(1);
    expect(r.badLinks).toHaveLength(1);
  });
  it("requires a disclosure when a cited source sells something", () => {
    const md = "## Tools\n\nIt [costs $20 a month](https://vendor.example/blog).";
    const r = ruleChecks({ article: { title: "T", bodyMarkdown: md }, sources }, sentences(md));
    expect(r.style.some((i) => i.problem.includes("sells"))).toBe(true);
    const ok = "## Tools\n\nVendor sells this app. It [costs $20 a month](https://vendor.example/blog).";
    expect(ruleChecks({ article: { title: "T", bodyMarkdown: ok }, sources }, sentences(ok)).style.some((i) => i.problem.includes("sells"))).toBe(false);
  });
  it("blocks em dashes, banned claims and words to avoid", () => {
    const md = "We are the cheapest — really. It is a cheap hack.";
    const r = ruleChecks({ article: { title: "T", bodyMarkdown: md }, sources, bannedClaims: ["we are the cheapest"], voice: { wordsToAvoid: ["hack"] } }, sentences(md));
    expect(r.banned).toHaveLength(1);
    expect(r.style.filter((i) => i.severity === "block").length).toBeGreaterThanOrEqual(2);
  });
  it("does not treat links to the customer's own site as citations", () => {
    const md = "Read [our pricing](https://mysite.com/pricing).";
    const r = ruleChecks({ article: { title: "T", bodyMarkdown: md }, sources, ownHosts: ["mysite.com"] }, sentences(md));
    expect(r.badLinks).toHaveLength(0);
  });
});

// A scripted judge, used only in this test to exercise the verdict logic without calling a model.
function scriptedJudge(citation: "supported" | "not_supported"): Judge {
  return {
    id: "test",
    async complete({ purpose }) {
      if (purpose === "quality_citations") return { results: [{ id: 1, verdict: citation, note: "n" }] } as never;
      return { voice_score: 90, voice_issues: [], unsourced: [], banned_hits: [], unlabeled_opinions: [], answers_first: true } as never;
    },
  };
}

describe("verdict", () => {
  const md = "Logs are kept for six months. Carriers must keep logs [for 6 months](https://gov.example/rules).";
  const input = { article: { title: "How long to keep logs?", bodyMarkdown: md, faq: [{ q: "q", a: "a" }] }, sources };
  it("passes a clean, supported article", async () => {
    const v = await checkArticle(input, scriptedJudge("supported"));
    expect(v.pass).toBe(true);
    expect(v.score).toBeGreaterThanOrEqual(80);
  });
  it("fails when the judge finds the source does not say it", async () => {
    const v = await checkArticle(input, scriptedJudge("not_supported"));
    expect(v.pass).toBe(false);
    expect(v.checks.find((c) => c.id === "citation_mismatch")!.pass).toBe(false);
  });
});

describe("worked examples", () => {
  it("treats the arithmetic after an example label as part of the example", () => {
    const md = "## Run the numbers\n\nHere is a made-up example, not real data.\n\nTwo engineers at $100,000 a quarter is $200,000.\n\n## Next\n\nIt costs $500.";
    const s = sentences(md);
    expect(s.find((x) => x.text.includes("$200,000"))!.isExample).toBe(true);
    expect(s.find((x) => x.text.includes("$500"))!.isExample).toBe(false);
  });
  it("does not treat a year as a statistic", () => {
    expect(findNumbers("Pricing in 2026 is up 12.5%.")).toEqual(["12.5%"]);
  });
});

import { linkTags } from "@/lib/engine/write";
describe("source tags", () => {
  it("turns [text](S2) into the exact source URL and drops unknown or bare tags", () => {
    const d = linkTags({ title: "", slug: "", meta_title: "", meta_description: "", excerpt: "", body_md: "Costs [$85 a year](S1) and [more](S9). Also true [S1].", faq: [{ q: "q", a: "See [the rule](S1)." }] }, [{ url: "https://gov.example/rules" }]);
    expect(d.body_md).toBe("Costs [$85 a year](https://gov.example/rules) and more. Also true.");
    expect(d.faq[0].a).toBe("See [the rule](https://gov.example/rules).");
  });
  it("counts the customer's own page as a source when it was read", () => {
    const own = [{ url: "https://mysite.com/pricing", text: "Plans start at $297 a month.", selling: false }];
    const md = "It costs [$297 a month](https://mysite.com/pricing).";
    expect(ruleChecks({ article: { title: "T", bodyMarkdown: md }, sources: own, ownHosts: ["mysite.com"] }, sentences(md)).stats).toHaveLength(0);
  });
});

describe("formulas and constants", () => {
  it("does not treat formulas or unit constants as statistics", () => {
    expect(findNumbers("Weekly admin hours (B x C / 60)")).toEqual([]);
    expect(findNumbers("That is 60 minutes, 24 hours, 52 weeks.")).toEqual([]);
    expect(findNumbers("It costs $60 and rose 60%.")).toEqual(["$60", "60%"]);
    expect(findNumbers("Small firms pay maximum taxes of 37 percent on 400 boxes.")).toEqual(["37 percent", "400"]);
  });
});

describe("shown calculations", () => {
  it("does not demand a source for numbers computed in plain sight", () => {
    const md = "Year one: $1,500 plus 12 times $297 comes to $5,064.";
    expect(ruleChecks({ article: { title: "T", bodyMarkdown: md }, sources }, sentences(md)).stats).toHaveLength(0);
  });
});

describe("cite once", () => {
  it("accepts a figure repeated later after it was verified in a linked sentence", () => {
    const md = "The fee is [$85 per year](https://gov.example/rules).\n\n## Summary\n\n| Item | Cost |\n|---|---|\n| Fee | $85 per year |";
    expect(ruleChecks({ article: { title: "T", bodyMarkdown: md }, sources }, sentences(md)).stats).toHaveLength(0);
  });
  it("still flags a new figure with no source", () => {
    const md = "The fee is [$85 per year](https://gov.example/rules).\n\nA filing costs $95.";
    expect(ruleChecks({ article: { title: "T", bodyMarkdown: md }, sources }, sentences(md)).stats).toHaveLength(1);
  });
});

describe("cite once, judge side", () => {
  const judge = (quote: string): Judge => ({
    id: "test",
    async complete({ purpose }) {
      if (purpose === "quality_citations") return { results: [{ id: 1, verdict: "supported", note: "n" }] } as never;
      return { voice_score: 90, voice_issues: [], unsourced: [{ quote, why: "No link here." }], banned_hits: [], unlabeled_opinions: [], answers_first: true } as never;
    },
  });
  const md = "Fees start at $85 per year, as shown below.\n\nThe fee is [$85 per year](https://gov.example/rules).";
  const input = { article: { title: "T", bodyMarkdown: md, faq: [{ q: "q", a: "a" }] }, sources };
  it("makes an unlinked preview of a figure sourced later a note", async () => {
    const v = await checkArticle(input, judge("Fees start at $85 per year, as shown below."));
    expect(v.checks.find((c) => c.id === "unsourced_claims")!.issues[0].severity).toBe("warn");
  });
});
