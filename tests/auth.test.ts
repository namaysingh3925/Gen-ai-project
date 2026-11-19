import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticate, createKey, revokeKey, rotateKey } from "@/lib/auth";
import { resetStoreForTests } from "@/lib/store";
import { bearer, ctx } from "./helpers";

beforeEach(() => {
  resetStoreForTests();
  process.env.RATE_LIMIT_PER_MINUTE = "30";
});
afterEach(() => {
  delete process.env.RATE_LIMIT_PER_MINUTE;
});

describe("API keys", () => {
  it("creates structured keys and stores only a hash", async () => {
    const { record, apiKey } = await createKey("test", ["generate", "read"]);
    expect(apiKey).toMatch(/^rsk_[a-f0-9]{12}_[A-Za-z0-9_-]{32}$/);
    expect(record.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain(apiKey.split("_")[2]);
  });

  it("authenticates a valid key and exposes rate-limit headers", async () => {
    const { record, apiKey } = await createKey("ok", ["generate", "read", "webhooks"]);
    const c = ctx(bearer(apiKey));
    const key = await authenticate(c, "generate");
    expect(key.id).toBe(record.id);
    expect((c as { headers: Headers }).headers.get("X-RateLimit-Limit")).toBe("30");
    expect((c as { headers: Headers }).headers.get("X-RateLimit-Remaining")).toBe("29");
  });

  it("accepts the X-API-Key header too", async () => {
    const { apiKey } = await createKey("x", ["read"]);
    await expect(authenticate(ctx({ "X-API-Key": apiKey }), "read")).resolves.toBeTruthy();
  });

  it("401s with distinct codes for missing / malformed / invalid keys", async () => {
    const { apiKey } = await createKey("x", ["read"]);
    await expect(authenticate(ctx(), "read")).rejects.toMatchObject({ status: 401, code: "missing_api_key" });
    await expect(authenticate(ctx(bearer("garbage")), "read")).rejects.toMatchObject({ status: 401, code: "invalid_api_key" });
    const wrongSecret = apiKey.slice(0, -1) + (apiKey.endsWith("a") ? "b" : "a");
    await expect(authenticate(ctx(bearer(wrongSecret)), "read")).rejects.toMatchObject({ status: 401, code: "invalid_api_key" });
    const unknownId = "rsk_000000000000_" + "A".repeat(32);
    const wrong = await authenticate(ctx(bearer(unknownId)), "read").catch((e) => e);
    const unknown = await authenticate(ctx(bearer(wrongSecret)), "read").catch((e) => e);
    expect(wrong.message).toBe(unknown.message); // key ids cannot be enumerated
  });

  it("returns WWW-Authenticate on 401", async () => {
    const err = await authenticate(ctx(), "read").catch((e) => e);
    expect(err.headers["WWW-Authenticate"]).toContain("Bearer");
  });

  it("403s when the scope is missing", async () => {
    const { apiKey } = await createKey("ro", ["read"]);
    await expect(authenticate(ctx(bearer(apiKey)), "webhooks")).rejects.toMatchObject({
      status: 403,
      code: "insufficient_scope",
      details: { required: "webhooks", granted: ["read"] },
    });
  });

  it("rejects revoked keys immediately", async () => {
    const { record, apiKey } = await createKey("rev", ["read"]);
    await authenticate(ctx(bearer(apiKey)), "read");
    await revokeKey(record);
    await expect(authenticate(ctx(bearer(apiKey)), "read")).rejects.toMatchObject({ status: 401, code: "revoked_api_key" });
  });

  it("rotation kills the old secret and keeps the id", async () => {
    const { record, apiKey } = await createKey("rot", ["read"]);
    const rotated = await rotateKey(record);
    expect(rotated.apiKey).not.toBe(apiKey);
    expect(rotated.record.id).toBe(record.id);
    await expect(authenticate(ctx(bearer(apiKey)), "read")).rejects.toMatchObject({ status: 401 });
    await expect(authenticate(ctx(bearer(rotated.apiKey)), "read")).resolves.toBeTruthy();
  });

  it("429s with Retry-After once the per-minute limit is exceeded", async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "3";
    const { apiKey } = await createKey("rl", ["read"]);
    for (let i = 0; i < 3; i++) await authenticate(ctx(bearer(apiKey)), "read");
    const err = await authenticate(ctx(bearer(apiKey)), "read").catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: "rate_limited" });
    expect(Number(err.headers["Retry-After"])).toBeGreaterThan(0);
  });
});
