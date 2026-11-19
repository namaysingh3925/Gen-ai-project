import { beforeEach, describe, expect, it } from "vitest";
import { hmacSha256 } from "@/lib/crypto";
import { resetStoreForTests } from "@/lib/store";
import { createSync, deleteSync, getSync, listSyncs, processGithubDelivery } from "@/lib/sync";

const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "Acme/Widget", default_branch: "main" }, ...over });

function headers(secret: string, raw: string, event = "push", delivery = "d-1") {
  return new Headers({
    "x-hub-signature-256": `sha256=${hmacSha256(secret, raw)}`,
    "x-github-event": event,
    "x-github-delivery": delivery,
  });
}

let sync: Awaited<ReturnType<typeof createSync>>;

beforeEach(async () => {
  resetStoreForTests();
  process.env.GENERATIONS_PER_DAY = "20";
  sync = await createSync("owner", { repoUrl: "https://github.com/acme/widget", types: ["readme"], style: "standard", language: "English", includeBadges: true });
});

const deliver = (raw: string, h: Headers, token = sync.hookToken) => processGithubDelivery(token, raw, h, "http://localhost");

describe("GitHub push sync", () => {
  it("creates an unguessable token and secret and lists / deletes subscriptions", async () => {
    expect(sync.hookToken.length).toBeGreaterThanOrEqual(30);
    expect(sync.secret).toMatch(/^ghsec_/);
    expect(await listSyncs("owner")).toHaveLength(1);
    expect(await listSyncs("other")).toHaveLength(0);
    await expect(getSync(sync.id, "other")).rejects.toMatchObject({ status: 404 });
    await deleteSync(sync);
    expect(await listSyncs("owner")).toHaveLength(0);
    await expect(deliver(payload(), headers(sync.secret, payload()))).rejects.toMatchObject({ status: 404, code: "hook_not_found" });
  });

  it("rejects unknown tokens (404) and bad or missing signatures (401)", async () => {
    const raw = payload();
    await expect(deliver(raw, headers(sync.secret, raw), "nope")).rejects.toMatchObject({ status: 404 });
    await expect(deliver(raw, headers("wrong-secret", raw))).rejects.toMatchObject({ status: 401, code: "invalid_signature" });
    await expect(deliver(raw, new Headers({ "x-github-event": "push" }))).rejects.toMatchObject({ status: 401, code: "invalid_signature" });
    // signature over a different body (tampering)
    await expect(deliver(payload({ ref: "refs/heads/evil" }), headers(sync.secret, raw))).rejects.toMatchObject({ status: 401 });
  });

  it("answers ping and ignores other events", async () => {
    const raw = payload();
    expect(await deliver(raw, headers(sync.secret, raw, "ping"))).toMatchObject({ status: 200, body: { ok: true, message: "pong" } });
    expect(await deliver(raw, headers(sync.secret, raw, "issues"))).toMatchObject({ status: 200, body: { ignored: "event" } });
  });

  it("ignores pushes to other branches and branch deletions", async () => {
    const feature = payload({ ref: "refs/heads/feature/x" });
    expect(await deliver(feature, headers(sync.secret, feature))).toMatchObject({ status: 200, body: { ignored: "branch" } });
    const del = payload({ deleted: true });
    expect(await deliver(del, headers(sync.secret, del, "push", "d-2"))).toMatchObject({ status: 200, body: { ignored: "branch_deleted" } });
  });

  it("queues a job on a push to the default branch, then dedupes and debounces", async () => {
    const raw = payload();
    const first = await deliver(raw, headers(sync.secret, raw, "push", "d-10"));
    expect(first.status).toBe(202);
    expect(first.job).toMatchObject({ source: "sync", status: "queued", keyId: "owner" });
    expect(first.body).toMatchObject({ status: "queued", docId: first.job!.id });
    expect((await getSync(sync.id, "owner")).triggerCount).toBe(1);

    // GitHub redelivery of the same event
    expect(await deliver(raw, headers(sync.secret, raw, "push", "d-10"))).toMatchObject({ status: 200, body: { ignored: "duplicate" } });
    // a different push right after (burst)
    expect(await deliver(raw, headers(sync.secret, raw, "push", "d-11"))).toMatchObject({ status: 200, body: { ignored: "debounced" } });
  });

  it("rejects a valid signature for the wrong repository", async () => {
    const raw = payload({ repository: { full_name: "evil/other", default_branch: "main" } });
    await expect(deliver(raw, headers(sync.secret, raw))).rejects.toMatchObject({ status: 400, code: "repository_mismatch" });
  });

  it("stops queueing once the owner's daily quota is gone", async () => {
    process.env.GENERATIONS_PER_DAY = "1";
    const { consumeGeneration } = await import("@/lib/ratelimit");
    await consumeGeneration("owner");
    const raw = payload();
    await expect(deliver(raw, headers(sync.secret, raw, "push", "d-20"))).rejects.toMatchObject({ status: 429, code: "daily_quota_exceeded" });
  });
});
