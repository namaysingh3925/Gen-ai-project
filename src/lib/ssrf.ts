/**
 * SSRF guard for user-supplied webhook URLs: https only, no credentials in the URL, and the
 * hostname must not be (or resolve to) a loopback / private / link-local address.
 * Disabled in development via ALLOW_PRIVATE_WEBHOOK_TARGETS so local receivers can be tested.
 * NOTE: DNS is re-checked before every delivery, which narrows (but cannot fully close) a
 * DNS-rebinding window; for stricter setups, deliver through an egress proxy.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "./env";
import { ApiError } from "./http";

export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (/^fe[89ab]/.test(v)) return true; // link-local fe80::/10
    if (/^f[cd]/.test(v)) return true; // unique-local fc00::/7
    if (v.startsWith("ff")) return true; // multicast
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
    if (hex) {
      const a = parseInt(hex[1], 16);
      const b = parseInt(hex[2], 16);
      return isPrivateAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
    return false;
  }
  const [a, b] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || b === 0)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast & reserved
  return false;
}

const bad = (message: string) => new ApiError(422, "invalid_webhook_url", message);

export async function assertSafeWebhookUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw bad("Webhook url must be a valid absolute URL.");
  }
  const allowPrivate = env.allowPrivateWebhookTargets;
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) throw bad("Webhook URLs must use https.");
  if (u.username || u.password) throw bad("Webhook URLs must not contain credentials.");
  if (allowPrivate) return u;

  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw bad("Webhook URLs must point to a public host.");
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw bad("Webhook URLs must point to a public address.");
    return u;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw bad("The webhook hostname could not be resolved.");
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw bad("Webhook URLs must resolve to public addresses.");
  }
  return u;
}
