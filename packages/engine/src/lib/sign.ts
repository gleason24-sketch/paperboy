// Signed tokens for OAuth state and one-click links. APP_SECRET must be a long random string (set in .env).
import crypto from "node:crypto";

const secret = () => {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 24) throw new Error("APP_SECRET is not set (or too short). See docs/self-host.md.");
  return s;
};

export function signState(data: Record<string, unknown>, ttlSeconds = 3600): string {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  const mac = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function readState<T = Record<string, unknown>>(token: string): T | null {
  const [body, mac] = (token || "").split(".");
  if (!body || !mac) return null;
  const want = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  const data = JSON.parse(Buffer.from(body, "base64url").toString()) as T & { exp: number };
  if (data.exp < Date.now() / 1000) return null;
  return data;
}

export const hashIp = (ip: string) => crypto.createHash("sha256").update(`${ip}:${process.env.APP_SECRET ?? ""}`).digest("hex").slice(0, 32);
export const randomHex = (n = 24) => crypto.randomBytes(n).toString("hex");
