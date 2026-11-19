import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStoreForTests } from "@/lib/store";
import { assertSafeWebhookUrl, isPrivateAddress } from "@/lib/ssrf";
import { createWebhook, deliver, dispatch, listDeliveries, listWebhooks, signPayload, verifySignature } from "@/lib/webhooks";
import { readBody, startServer } from "./helpers";

beforeEach(() => resetStoreForTests());
afterEach(() => {
  delete process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS;
});

describe("signatures", () => {
  it("round-trips and rejects tampering / stale timestamps / wrong secret", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"a":1}';
    const sig = signPayload("whsec_x", ts, body);
    expect(sig).toMatch(/^v1=[a-f0-9]{64}$/);
    expect(verifySignature("whsec_x", sig, ts, body)).toBe(true);
    expect(verifySignature("whsec_x", sig, ts, '{"a":2}')).toBe(false);
    expect(verifySignature("whsec_y", sig, ts, body)).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifySignature("whsec_x", signPayload("whsec_x", old, body), old, body)).toBe(false);
  });
});

describe("SSRF guard", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1"])(
    "%s is private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it("blocks unsafe targets in production mode", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "false";
    for (const url of [
      "http://example.com/hook", // not https
      "https://localhost/hook",
      "https://127.0.0.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/hook",
      "https://user:pass@example.com/hook",
      "https://service.internal/hook",
      "not a url",
    ]) {
      await expect(assertSafeWebhookUrl(url), url).rejects.toMatchObject({ status: 422, code: "invalid_webhook_url" });
    }
  });

  it("allows https public IP literals", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "false";
    await expect(assertSafeWebhookUrl("https://8.8.8.8/hook")).resolves.toBeInstanceOf(URL);
  });
});

describe("delivery", () => {
  it("delivers a signed JSON event the receiver can verify", async () => {
    let seen: { headers: Record<string, unknown>; body: string } | null = null;
    const srv = await startServer(async (req, res) => {
      seen = { headers: req.headers, body: await readBody(req) };
      res.writeHead(200).end("ok");
    });
    try {
      const hook = await createWebhook("key1", { url: `${srv.url}/h`, events: ["doc.completed"] });
      const d = await deliver(hook, "doc.completed", { id: "doc_1" });
      expect(d).toMatchObject({ status: "success", attempts: 1, responseStatus: 200 });

      const { headers, body } = seen!;
      expect(headers["content-type"]).toBe("application/json");
      expect(headers["x-reposcribe-event"]).toBe("doc.completed");
      const parsed = JSON.parse(body);
      expect(parsed).toMatchObject({ type: "doc.completed", apiVersion: "v1", data: { id: "doc_1" } });
      expect(parsed.id).toMatch(/^evt_/);
      expect(verifySignature(hook.secret, String(headers["x-reposcribe-signature"]), String(headers["x-reposcribe-timestamp"]), body)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("retries 5xx responses and eventually succeeds", async () => {
    let hits = 0;
    const srv = await startServer((_req, res) => {
      res.writeHead(++hits < 2 ? 503 : 200).end();
    });
    try {
      const hook = await createWebhook("key2", { url: `${srv.url}/h`, events: ["ping"] });
      const d = await deliver(hook, "ping", {});
      expect(d).toMatchObject({ status: "success", attempts: 2, responseStatus: 200 });
    } finally {
      await srv.close();
    }
  }, 15_000);

  it("does not retry 4xx, does not follow redirects, and logs the failure", async () => {
    let hits = 0;
    const srv = await startServer((req, res) => {
      hits++;
      if (req.url === "/redirect") res.writeHead(302, { Location: "http://127.0.0.1:1/internal" }).end();
      else res.writeHead(400).end();
    });
    try {
      const bad = await createWebhook("key3", { url: `${srv.url}/h`, events: ["ping"] });
      expect(await deliver(bad, "ping", {})).toMatchObject({ status: "failed", attempts: 1, responseStatus: 400 });

      const redirecting = await createWebhook("key3", { url: `${srv.url}/redirect`, events: ["ping"] });
      const d = await deliver(redirecting, "ping", {});
      expect(d.status).toBe("failed");
      expect(d.responseStatus).toBe(302);
      expect(hits).toBe(2 + 0); // one call per hook, redirect target never contacted

      const log = await listDeliveries(bad.id);
      expect(log).toHaveLength(1);
      expect(log[0].status).toBe("failed");
    } finally {
      await srv.close();
    }
  });

  it("dispatch only reaches subscribed, active webhooks of the owning key", async () => {
    const received: string[] = [];
    const srv = await startServer(async (req, res) => {
      received.push(req.url ?? "");
      await readBody(req);
      res.writeHead(204).end();
    });
    try {
      await createWebhook("owner", { url: `${srv.url}/completed`, events: ["doc.completed"] });
      await createWebhook("owner", { url: `${srv.url}/failed`, events: ["doc.failed"] });
      await createWebhook("someone-else", { url: `${srv.url}/other`, events: ["doc.completed"] });
      await dispatch("owner", "doc.completed", { id: "d" });
      expect(received).toEqual(["/completed"]);
    } finally {
      await srv.close();
    }
  });

  it("caps webhooks per key and auto-disables after repeated failures", async () => {
    const srv = await startServer((_req, res) => res.writeHead(400).end());
    try {
      const hook = await createWebhook("capkey", { url: `${srv.url}/h`, events: ["ping"] });
      for (let i = 0; i < 10; i++) await deliver(hook, "ping", {});
      const [after] = await listWebhooks("capkey");
      expect(after.active).toBe(false);
      expect(after.failureCount).toBe(10);

      for (let i = 0; i < 4; i++) await createWebhook("capkey", { url: `${srv.url}/h${i}`, events: ["ping"] });
      await expect(createWebhook("capkey", { url: `${srv.url}/x`, events: ["ping"] })).rejects.toMatchObject({ status: 409, code: "webhook_limit_reached" });
    } finally {
      await srv.close();
    }
  });
});
