import { authenticate, publicKey, revokeKey } from "@/lib/auth";
import { env } from "@/lib/env";
import { json, noContent, preflight, route } from "@/lib/http";
import { generationUsage } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const OPTIONS = preflight;

/** Introspect the calling key: scopes, limits and today's usage. */
export const GET = route(async (c) => {
  const key = await authenticate(c);
  const quota = await generationUsage(key.id);
  return json({
    ...publicKey(key),
    limits: { requestsPerMinute: env.ratePerMinute, generationsPerDay: env.generationsPerDay },
    usage: {
      generationsToday: quota.used,
      generationsRemainingToday: quota.remaining,
      quotaResetsAt: new Date(quota.resetAt * 1000).toISOString(),
    },
  });
});

/** Revoke the calling key immediately. */
export const DELETE = route(async (c) => {
  const key = await authenticate(c);
  await revokeKey(key);
  return noContent();
});
