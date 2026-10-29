import { describe, expect, it } from "vitest";
import { computeOpportunities, type OppRow } from "@/lib/rankloop/opps";
import { scoreTest } from "@/lib/rankloop/measure";
import { diffTitleMeta, pagesToWatch, recentlyLogged } from "@/lib/rankloop/snapshots";
import { rankLoopStatus, sortRankLoop, type LoopStats } from "@/lib/rankloop/status";
import { clampTitle, styleBlock, titleMetaIssues } from "@/lib/rankloop/titles";

const cur = (page: string, query: string, clicks: number, impressions: number, position: number): OppRow => ({ win: "cur", page, query, clicks, impressions, position });
const base = (rows: OppRow[]): OppRow[] => [...rows, { win: "cur_total", page: "", query: "", clicks: 0, impressions: 5000, position: null }];

describe("opportunity buckets", () => {
  it("finds ctr_fix: ranks near the top, nobody clicks", () => {
    const o = computeOpportunities(base([cur("https://x.com/pricing", "x pricing", 1, 400, 3)]));
    expect(o.ctr_fix).toHaveLength(1);
    expect(o.ctr_fix[0]).toMatchObject({ page: "/pricing", impressions: 400 });
  });
  it("finds needs_own_page: a query ranks from a page that is not about it", () => {
    const o = computeOpportunities(base([cur("https://x.com/about", "dog grooming prices", 2, 200, 14), cur("https://x.com/blog/cats", "cat food", 30, 300, 5)]));
    expect(o.needs_own_page.map((x) => x.query)).toEqual(["dog grooming prices"]);
  });
  it("does not ask for a new page when a matching page exists", () => {
    const o = computeOpportunities(base([cur("https://x.com/about", "dog grooming prices", 2, 200, 14), cur("https://x.com/dog-grooming-prices", "dog grooming", 9, 100, 4)]));
    expect(o.needs_own_page).toHaveLength(0);
  });
  it("finds push_to_1 and striking_distance", () => {
    const o = computeOpportunities(base([cur("https://x.com/a", "alpha guide", 40, 500, 4), cur("https://x.com/b", "beta guide", 1, 300, 18)]));
    expect(o.push_to_1.map((x) => x.query)).toEqual(["alpha guide"]);
    expect(o.striking_distance.map((x) => x.query)).toEqual(["beta guide"]);
  });
  it("finds a cluster of related queries at positions 20 to 70", () => {
    const o = computeOpportunities(base(["tax filing help", "tax filing deadline", "tax filing checklist"].map((q, i) => cur(`https://x.com/p${i}`, q, 0, 40, 35))));
    expect(o.cluster[0]).toMatchObject({ term: "tax", query_count: 3 });
  });
  it("finds slipping pages against the prior 28 days", () => {
    const rows: OppRow[] = [...base([cur("https://x.com/a", "alpha", 5, 100, 8)]), { win: "prior", page: "https://x.com/a", query: "", clicks: 50, impressions: 400, position: 4 }];
    expect(computeOpportunities(rows).slipping[0]).toMatchObject({ page: "/a", prior_clicks: 50, clicks: 5 });
  });
});

describe("title and meta rules", () => {
  const meta = "Compare the three plans side by side, see what each includes and how billing works before you pick one for your team today.";
  it("accepts a good pair", () => {
    expect(meta.length).toBeGreaterThanOrEqual(120);
    expect(titleMetaIssues({ title: "Dog grooming prices: what to expect (2026)", meta }, "dog grooming prices", new Date("2026-10-13"))).toEqual([]);
  });
  it("rejects long titles, short meta, dashes, promises, past years and a buried query", () => {
    const issues = titleMetaIssues({ title: "Our company is the very best place to learn all about dog grooming prices \u2014 guaranteed #1 (2019)", meta: "short" }, "dog grooming prices", new Date("2026-10-13"));
    expect(issues.join("|")).toMatch(/limit is 60/);
    expect(issues.join("|")).toMatch(/meta description/);
    expect(issues.join("|")).toMatch(/dash/);
    expect(issues.join("|")).toMatch(/promises/);
    expect(issues.join("|")).toMatch(/past year/);
    expect(issues.join("|")).toMatch(/near the front/);
  });
  it("clamps at a word boundary", () => {
    const t = clampTitle("Dog grooming prices: what a full groom costs by breed and size in 2026");
    expect(t!.length).toBeLessThanOrEqual(60);
    expect("Dog grooming prices: what a full groom costs by breed and size in 2026".startsWith(t!)).toBe(true);
  });
  it("feeds winning and losing styles back, per site, and stays empty without results", () => {
    expect(styleBlock([{ outcome: "pending", new_title: "x", old_title: "y" }])).toBe("");
    const b = styleBlock([{ outcome: "win", new_title: "Dog grooming prices: 3 sizes (2026)", old_title: "a" }, { outcome: "loss", new_title: "Welcome to our grooming blog", old_title: "b" }]);
    expect(b).toMatch(/copy their shape:\n- "Dog grooming prices: 3 sizes \(2026\)"/);
    expect(b).toMatch(/avoid their shape:\n- "Welcome to our grooming blog"/);
  });
});

describe("scoring a change", () => {
  const s = (clicks: number, impressions: number) => ({ clicks, impressions, position: 5 });
  it("win: click-through up", () => expect(scoreTest(s(10, 500), s(25, 520)).outcome).toBe("win"));
  it("loss: click-through down", () => expect(scoreTest(s(25, 500), s(10, 500)).outcome).toBe("loss"));
  it("neutral: about the same", () => expect(scoreTest(s(20, 500), s(21, 500)).outcome).toBe("neutral"));
  it("neutral: too little data", () => expect(scoreTest(s(1, 10), s(5, 10)).outcome).toBe("neutral"));
  it("a fall in impressions alone is not blamed on the title", () => expect(scoreTest(s(30, 600), s(20, 300)).outcome).toBe("neutral"));
});

describe("snapshots", () => {
  it("first sight is never a change; an empty read is not a removal", () => {
    expect(diffTitleMeta(null, { title: "A", meta_description: "B", h1: null })).toBeNull();
    expect(diffTitleMeta({ title: "A", meta_description: "B", h1: null }, { title: "", meta_description: null, h1: null })).toBeNull();
  });
  it("sees a title or meta change", () => {
    expect(diffTitleMeta({ title: "A", meta_description: "B", h1: null }, { title: "A2", meta_description: "B", h1: null })?.new.title).toBe("A2");
  });
  it("logs one change per page per week", () => {
    const now = Date.parse("2026-10-13");
    expect(recentlyLogged([{ page_url: "x.com/a", changed_at: "2026-10-10" }], "https://www.x.com/a/", now)).toBe(true);
    expect(recentlyLogged([{ page_url: "x.com/a", changed_at: "2026-09-01" }], "https://x.com/a", now)).toBe(false);
  });
  it("watches the top pages on the customer's own host only", () => {
    const rows = [{ win: "cur", page: "https://x.com/a", impressions: 10 }, { win: "cur", page: "https://other.com/z", impressions: 99 }, { win: "cur", page: "https://www.x.com/a?x=1", impressions: 5 }];
    expect(pagesToWatch(rows, "https://x.com")).toEqual(["https://x.com/a"]);
  });
});

describe("rank loop status", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const stats = (o: Partial<LoopStats> = {}): LoopStats => ({
    hasProperty: true, lastDataDate: "2026-10-11", trackingSince: "2026-09-01", open: {}, fixes7d: 0, fixes28d: 0, lastFixAt: null, tests: { win: 0, loss: 0, neutral: 0, pending: 0 }, ...o,
  });
  it("NO_GSC without a property or fresh data", () => {
    expect(rankLoopStatus(stats({ hasProperty: false }), now).status).toBe("NO_GSC");
    expect(rankLoopStatus(stats({ lastDataDate: "2026-09-01" }), now).status).toBe("NO_GSC");
  });
  it("STALLED: urgent fixes open, none shipped in 7 days, tracked for 7+ days", () => {
    expect(rankLoopStatus(stats({ open: { ctr_fix: 2 } }), now).status).toBe("STALLED");
    expect(rankLoopStatus(stats({ open: { ctr_fix: 2 }, trackingSince: "2026-10-10" }), now).status).toBe("OK");
  });
  it("BEHIND: under 5 fixes in 7 days with 5+ open", () => {
    expect(rankLoopStatus(stats({ open: { push_to_1: 6 }, fixes7d: 2 }), now).status).toBe("BEHIND");
  });
  it("OK otherwise, and sorts worst first", () => {
    expect(rankLoopStatus(stats({ open: { push_to_1: 6 }, fixes7d: 6 }), now).status).toBe("OK");
    const rows = [{ status: "OK", domain: "a.com" }, { status: "STALLED", domain: "b.com" }, { status: "NO_GSC", domain: "c.com" }] as const;
    expect(sortRankLoop([...rows]).map((r) => r.domain)).toEqual(["c.com", "b.com", "a.com"]);
  });
});
