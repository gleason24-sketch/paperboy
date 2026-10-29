// Small shared helpers. Safe for server and browser.

export function normalizeUrl(input: string): string | null {
  let s = (input || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname.includes(".")) return null;
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function slugify(s: string, max = 70): string {
  return (
    (s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "post"
  );
}

export function escapeHtml(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Removes em dashes and spaced en dashes. Product rule: no em dashes anywhere. */
export function noDashes(s: string): string {
  return (s ?? "")
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s+–\s+/g, ", ")
    .replace(/(\d)–(\d)/g, "$1-$2")
    .replace(/–/g, "-")
    .replace(/,\s*,/g, ",");
}

export function noDashesDeep<T>(v: T): T {
  if (typeof v === "string") return noDashes(v) as T;
  if (Array.isArray(v)) return v.map(noDashesDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, noDashesDeep(x)])) as T;
  return v;
}

export const fmtInt = (n: number | null | undefined) => (n == null ? "-" : Math.round(n).toLocaleString("en-US"));
export const fmtUsd = (n: number | null | undefined, digits = 2) =>
  n == null ? "-" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const fmtPos = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || n === 0 ? "-" : n.toFixed(1));

export function fmtDate(d: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  if (!d) return "-";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
}

export function pctChange(now: number, before: number): number | null {
  if (!before) return now ? null : 0;
  return ((now - before) / before) * 100;
}

export const QUESTION_RE = /^(how|what|why|when|where|which|who|can|should|is|are|do|does|will|would|best|vs)\b/i;

/** Word-set overlap between two phrases (0 to 1), used to keep topics from repeating. */
export function overlap(a: string, b: string): number {
  const stop = new Set(["the", "a", "an", "to", "for", "of", "in", "and", "or", "on", "with", "how", "what", "is", "are", "your", "you", "do", "i", "my", "vs", "best"]);
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !stop.has(w)));
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}
