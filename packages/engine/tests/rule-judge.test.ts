import { describe, expect, it } from "vitest";
import { checkArticle, RuleJudge, HostedVerifier, LocalVerifier } from "@/lib/quality";
import { overlap } from "@/lib/quality/rule-judge";
import type { Verdict } from "@/lib/quality";

const source = { url: "https://example.org/report", text: "In 2024 the survey of 1200 owners found that 45 percent paid $2.65 per mile for hauling freight across the region." };
const article = (body: string) => ({
  article: { title: "What do owners pay per mile?", bodyMarkdown: body, faq: [{ q: "Is it a lot?", a: "It depends on the lane." }] },
  sources: [source],
});

describe("RuleJudge", () => {
  it("scores word overlap", () => {
    expect(overlap("Owners paid $2.65 per mile for hauling freight.", [source.text])).toBeGreaterThan(0.6);
    expect(overlap("Quantum computers solve protein folding quickly.", [source.text])).toBeLessThan(0.35);
  });

  it("passes a sentence its source supports, with no model", async () => {
    const v = await checkArticle(article("Owners paid [$2.65 per mile](https://example.org/report) for hauling freight across the region in 2024."), new RuleJudge());
    expect(v.judge).toBe("rules-v1");
    expect(v.checks.find((c) => c.id === "citation_mismatch")?.pass).toBe(true);
    expect(v.checks.find((c) => c.id === "made_up_stats")?.pass).toBe(true);
  });

  it("holds a number that is not in the cited source", async () => {
    const v = await checkArticle(article("Owners paid [$9.99 per mile](https://example.org/report) for hauling freight across the region in 2024."), new RuleJudge());
    expect(v.pass).toBe(false);
    expect(v.checks.find((c) => c.id === "made_up_stats")?.pass).toBe(false);
  });

  it("holds a link to a page that was never read", async () => {
    const v = await checkArticle(article("Owners paid [a lot](https://unread.example.net/x) for hauling freight across the region."), new RuleJudge());
    expect(v.checks.find((c) => c.id === "citation_mismatch")?.pass).toBe(false);
  });
});

describe("HostedVerifier", () => {
  const verdict: Verdict = { pass: true, score: 92, summary: "Passed.", judge: "hosted-test", checks: [] };

  it("posts to /api/v1/verify with the bearer key and returns the verdict", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get("authorization") };
      return new Response(JSON.stringify({ verdict }), { status: 200 });
    }) as unknown as typeof fetch;
    const v = await new HostedVerifier({ apiKey: "pb_live_test", baseUrl: "https://verify.example.com/", fetch: fake }).verify(article("Plain text."));
    expect(v).toEqual(verdict);
    expect(seen).toEqual({ url: "https://verify.example.com/api/v1/verify", auth: "Bearer pb_live_test" });
  });

  it("fails loudly on a bad answer instead of passing", async () => {
    const fake = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(new HostedVerifier({ apiKey: "k", fetch: fake }).verify(article("Plain text."))).rejects.toThrow(/500/);
  });
});

describe("LocalVerifier", () => {
  it("wraps a judge", async () => {
    const v = await new LocalVerifier(new RuleJudge()).verify(article("Owners paid [$2.65 per mile](https://example.org/report) for hauling freight across the region in 2024."));
    expect(v.judge).toBe("rules-v1");
  });
});
