import type { ScanResult } from "@/lib/engine/scan";

export type SiteRow = {
  id: string;
  owner_id: string;
  url: string;
  domain: string;
  name: string;
  slug: string;
  scan: Partial<ScanResult>;
  voice: { interview?: { q: string; a: string }[]; description?: string };
  banned_claims: string[];
  words_to_avoid: string[];
  cta_text: string;
  cta_url: string;
  publish_method: "hosted" | "prompt" | "wordpress" | "ghost" | "webhook";
  publish_config: Record<string, any>;
  approval_mode: "autopilot" | "approve";
  plan: "free" | "starter" | "growth" | "pro";
  billing_interval: "month" | "year" | null;
  subscription_status: string | null;
  stripe_subscription_id: string | null;
  trial_started_at?: string | null;
  trial_ends_at?: string | null;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  revenue_cents_monthly: number;
  site_key: string;
  indexnow_key: string;
  blog_host: string | null;
  blog_host_status: "not_set" | "waiting_dns" | "live" | "error";
  gsc_property: string | null;
  gsc_connected_at: string | null;
  gsc_error?: string | null;
  gsc_error_at?: string | null;
  gsc_totals_fetched_at?: string | null;
  gsc_last_sync: string | null;
  gsc_skipped: boolean;
  paused: boolean;
  created_at: string;
};

export type ArticleStatus =
  | "planned" | "picking" | "researching" | "writing" | "checking" | "fixing" | "publishing" | "published" | "needs_review" | "failed";

export type ArticleRow = {
  id: string;
  site_id: string;
  owner_id: string;
  status: ArticleStatus;
  seen_at?: string | null;
  review_reason: "quality" | "approval" | "cost_cap" | "publish_error" | "error" | null;
  review_note: string | null;
  step_note: string | null;
  kind: "new" | "refresh";
  refresh_of: string | null;
  is_free: boolean;
  topic: string | null;
  target_query: string | null;
  angle: string | null;
  intent: string | null;
  reason: string | null;
  title: string | null;
  slug: string | null;
  meta_title: string | null;
  meta_description: string | null;
  excerpt: string | null;
  body_md: string | null;
  body_html: string | null;
  faq: { q: string; a: string }[];
  schema_ld: unknown[];
  sources: { url: string; title: string; selling: boolean }[];
  internal_links: string[];
  cta_text: string | null;
  cta_url: string | null;
  quality_score: number | null;
  quality_pass: boolean | null;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  searches: number;
  published_url: string | null;
  external_id: string | null;
  published_at: string | null;
  updated_content_at: string | null;
  approval_token: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  locked_until: string | null;
};

/** The plain-language label the dashboard shows for each pipeline status. */
export const STATUS_LABEL: Record<ArticleStatus, string> = {
  planned: "Planned",
  picking: "Planned",
  researching: "Researching",
  writing: "Writing",
  checking: "Checking",
  fixing: "Writing",
  publishing: "Checking",
  published: "Published",
  needs_review: "Needs your review",
  failed: "Needs your review",
};

export const STATUS_TONE: Record<ArticleStatus, "planned" | "progress" | "published" | "review" | "error"> = {
  planned: "planned",
  picking: "progress",
  researching: "progress",
  writing: "progress",
  checking: "progress",
  fixing: "progress",
  publishing: "progress",
  published: "published",
  needs_review: "review",
  failed: "error",
};

export const IN_PROGRESS: ArticleStatus[] = ["picking", "researching", "writing", "checking", "fixing", "publishing"];
