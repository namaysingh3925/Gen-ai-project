"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, describeError, getStoredKey, issueKey, setStoredKey } from "@/lib/client";
import { DOC_TYPES, WEBHOOK_EVENTS } from "@/lib/types";

interface KeyInfo {
  id: string;
  name: string;
  scopes: string[];
  keyPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
  limits: { requestsPerMinute: number; generationsPerDay: number };
  usage: { generationsToday: number; generationsRemainingToday: number; quotaResetsAt: string };
}
interface Hook {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  active: boolean;
  failureCount: number;
  createdAt: string;
}
interface Delivery {
  id: string;
  event: string;
  status: "success" | "failed";
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  durationMs: number;
  at: string;
}
interface SyncItem {
  id: string;
  repo: string;
  options: { types: string[] };
  payloadUrl: string;
  triggerCount: number;
  lastTriggeredAt: string | null;
}

const input = "w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent";
const btn = "rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent hover:text-accent disabled:opacity-50";
const btnPrimary = "rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50";

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl border border-line bg-surface p-5">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={btn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? "Copied!" : label}
    </button>
  );
}

function SecretBox({ title, items }: { title: string; items: { label: string; value: string }[] }) {
  return (
    <div role="status" className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
      <p className="font-medium text-amber-800 dark:text-amber-200">{title} - shown only once, copy it now.</p>
      {items.map((i) => (
        <div key={i.label} className="flex flex-wrap items-center gap-2">
          <span className="w-24 shrink-0 text-xs text-muted">{i.label}</span>
          <code className="min-w-0 flex-1 break-all rounded bg-bg px-2 py-1 text-xs">{i.value}</code>
          <CopyButton text={i.value} />
        </div>
      ))}
    </div>
  );
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

/* ----------------------------------- API key ----------------------------------- */

function KeySection({ origin }: { origin: string }) {
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await api<KeyInfo>("/api/v1/keys/me"));
      setKey(getStoredKey());
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function rotate() {
    if (!window.confirm("Rotate this key? The current secret stops working immediately.")) return;
    setBusy(true);
    try {
      const res = await api<{ apiKey: string }>("/api/v1/keys/me/rotate", { method: "POST" });
      setStoredKey(res.apiKey);
      setReveal(true);
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!window.confirm("Revoke this key and create a new one? Anything using the old key will get 401.")) return;
    setBusy(true);
    try {
      await api("/api/v1/keys/me", { method: "DELETE" });
      setStoredKey(null);
      await issueKey();
      setReveal(true);
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const shown = key ? (reveal ? key : (info?.keyPreview ?? "rsk_************")) : "No key stored in this browser";
  const keyForDocs = reveal && key ? key : "$REPOSCRIBE_API_KEY";
  const used = info?.usage.generationsToday ?? 0;
  const limit = info?.limits.generationsPerDay ?? 1;

  return (
    <Section title="Your API key" subtitle="This browser created its own key automatically. Use the same key from scripts and other apps.">
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg border border-line bg-bg px-3 py-2 text-xs">{shown}</code>
        {key && (
          <>
            <button className={btn} onClick={() => setReveal(!reveal)}>
              {reveal ? "Hide" : "Reveal"}
            </button>
            <CopyButton text={key} />
          </>
        )}
      </div>
      {info && (
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <div className="text-xs text-muted">Scopes</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {info.scopes.map((s) => (
                <span key={s} className="rounded-full bg-accent-soft px-2 py-0.5 text-xs">
                  {s}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">Rate limit</div>
            <div className="mt-1">{info.limits.requestsPerMinute} requests / minute</div>
          </div>
          <div>
            <div className="text-xs text-muted">Generations today</div>
            <div className="mt-1">
              {used} / {limit}
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-accent-soft">
              <div className="h-full bg-accent" style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
            </div>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button className={btn} onClick={rotate} disabled={busy}>
          Rotate secret
        </button>
        <button className={btn} onClick={revoke} disabled={busy}>
          Revoke &amp; create new
        </button>
        <span className="self-center text-xs text-muted">Created {fmt(info?.createdAt ?? null)} - last used {fmt(info?.lastUsedAt ?? null)}</span>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Quickstart</h3>
        <pre className="overflow-x-auto rounded-lg border border-line bg-bg p-3 text-xs leading-relaxed">{`# 1. generate (sync; use "async": true to get a 202 and poll instead)
curl -X POST ${origin}/api/v1/generate \\
  -H "Authorization: Bearer ${keyForDocs}" \\
  -H "Content-Type: application/json" \\
  -d '{"repoUrl":"https://github.com/octocat/Hello-World","types":["readme"]}'

# 2. export the result as Markdown
curl -H "Authorization: Bearer ${keyForDocs}" \\
  "${origin}/api/v1/docs/<id>?format=markdown&type=readme&download=1" -o README.md`}</pre>
      </div>
    </Section>
  );
}

/* ------------------------------------ webhooks ------------------------------------ */

function WebhooksSection() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["doc.completed", "doc.failed"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, Delivery>>({});
  const [logs, setLogs] = useState<Record<string, Delivery[] | null>>({});

  const load = useCallback(async () => {
    try {
      setHooks((await api<{ data: Hook[] }>("/api/v1/webhooks")).data);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSecret(null);
    try {
      const res = await api<Hook & { secret: string }>("/api/v1/webhooks", { method: "POST", json: { url: url.trim(), events } });
      setSecret(res.secret);
      setUrl("");
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function test(id: string) {
    setError(null);
    try {
      const d = await api<Delivery>(`/api/v1/webhooks/${id}/test`, { method: "POST" });
      setTestResult((r) => ({ ...r, [id]: d }));
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function toggleLog(id: string) {
    if (logs[id]) return setLogs((l) => ({ ...l, [id]: null }));
    try {
      setLogs((l) => ({ ...l, [id]: [] }));
      const res = await api<{ data: Delivery[] }>(`/api/v1/webhooks/${id}/deliveries`);
      setLogs((l) => ({ ...l, [id]: res.data }));
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this webhook?")) return;
    try {
      await api(`/api/v1/webhooks/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const toggleEvent = (ev: string) => setEvents((cur) => (cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev]));

  return (
    <Section title="Webhooks" subtitle="Get a signed JSON POST when a document set finishes. HTTPS endpoints only; private and localhost targets are blocked.">
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
      <form onSubmit={create} className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/reposcribe" required className={input} aria-label="Webhook URL" />
          <button className={btnPrimary} disabled={busy || !url.trim() || events.length === 0}>
            Add webhook
          </button>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          {WEBHOOK_EVENTS.map((ev) => (
            <label key={ev} className="flex items-center gap-1.5">
              <input type="checkbox" checked={events.includes(ev)} onChange={() => toggleEvent(ev)} />
              <code className="text-xs">{ev}</code>
            </label>
          ))}
        </div>
      </form>
      {secret && <SecretBox title="Signing secret" items={[{ label: "Secret", value: secret }]} />}

      {hooks.length === 0 ? (
        <p className="text-sm text-muted">No webhooks yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {hooks.map((h) => (
            <li key={h.id} className="space-y-2 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{h.url}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span className={`rounded-full px-2 py-0.5 ${h.active ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-red-500/15 text-red-700 dark:text-red-300"}`}>{h.active ? "active" : "disabled"}</span>
                    {h.events.map((ev) => (
                      <code key={ev}>{ev}</code>
                    ))}
                    {h.failureCount > 0 && <span>- {h.failureCount} consecutive failures</span>}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button className={btn} onClick={() => test(h.id)}>
                    Send test
                  </button>
                  <button className={btn} onClick={() => toggleLog(h.id)}>
                    {logs[h.id] ? "Hide log" : "Deliveries"}
                  </button>
                  <button className={btn} onClick={() => remove(h.id)}>
                    Delete
                  </button>
                </div>
              </div>
              {testResult[h.id] && (
                <p className={`text-xs ${testResult[h.id].status === "success" ? "text-emerald-600 dark:text-emerald-300" : "text-red-600 dark:text-red-300"}`}>
                  Test {testResult[h.id].status}: HTTP {testResult[h.id].responseStatus ?? "-"} after {testResult[h.id].attempts} attempt(s), {testResult[h.id].durationMs} ms
                  {testResult[h.id].error ? ` - ${testResult[h.id].error}` : ""}
                </p>
              )}
              {logs[h.id] && (
                <table className="w-full text-left text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th className="py-1 font-medium">When</th>
                      <th className="font-medium">Event</th>
                      <th className="font-medium">Result</th>
                      <th className="font-medium">HTTP</th>
                      <th className="font-medium">Tries</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs[h.id]!.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-2 text-muted">
                          No deliveries yet.
                        </td>
                      </tr>
                    )}
                    {logs[h.id]!.map((d) => (
                      <tr key={d.id} className="border-t border-line">
                        <td className="py-1">{new Date(d.at).toLocaleTimeString()}</td>
                        <td>
                          <code>{d.event}</code>
                        </td>
                        <td className={d.status === "success" ? "text-emerald-600 dark:text-emerald-300" : "text-red-600 dark:text-red-300"}>{d.status}</td>
                        <td>{d.responseStatus ?? "-"}</td>
                        <td>{d.attempts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          ))}
        </ul>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-muted hover:text-ink">Verify signatures in your receiver (Node.js)</summary>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-bg p-3 text-xs leading-relaxed">{`import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody must be the exact request body string (don't re-serialise parsed JSON)
function verify(secret, headers, rawBody) {
  const ts = headers["x-reposcribe-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay protection
  const expected = "v1=" + createHmac("sha256", secret).update(ts + "." + rawBody).digest("hex");
  const given = headers["x-reposcribe-signature"] ?? "";
  return expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}`}</pre>
      </details>
    </Section>
  );
}

/* ----------------------------------- auto-sync ----------------------------------- */

function SyncSection() {
  const [items, setItems] = useState<SyncItem[]>([]);
  const [repo, setRepo] = useState("");
  const [types, setTypes] = useState<string[]>(["readme"]);
  const [created, setCreated] = useState<{ payloadUrl: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ data: SyncItem[] }>("/api/v1/sync")).data);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const res = await api<SyncItem & { secret: string }>("/api/v1/sync", { method: "POST", json: { repoUrl: repo.trim(), types } });
      setCreated({ payloadUrl: res.payloadUrl, secret: res.secret });
      setRepo("");
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Stop auto-syncing this repository?")) return;
    try {
      await api(`/api/v1/sync/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const toggle = (t: string) => setTypes((cur) => (cur.includes(t) ? (cur.length > 1 ? cur.filter((x) => x !== t) : cur) : [...cur, t]));

  return (
    <Section title="Auto-sync on GitHub push" subtitle="Keep docs fresh: GitHub calls RepoScribe on every push and the documents are regenerated automatically (public repositories).">
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
      <form onSubmit={create} className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/owner/repo" required className={input} aria-label="Repository URL" />
          <button className={btnPrimary} disabled={busy || !repo.trim()}>
            Create sync
          </button>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          {DOC_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-1.5">
              <input type="checkbox" checked={types.includes(t)} onChange={() => toggle(t)} />
              {t}
            </label>
          ))}
        </div>
      </form>
      {created && (
        <div className="space-y-2">
          <SecretBox
            title="GitHub webhook settings"
            items={[
              { label: "Payload URL", value: created.payloadUrl },
              { label: "Secret", value: created.secret },
            ]}
          />
          <p className="text-xs text-muted">
            In the repository: <b>Settings &rarr; Webhooks &rarr; Add webhook</b>. Paste the URL and secret, set Content type to <code>application/json</code>, choose <b>Just the push event</b>.
          </p>
        </div>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {items.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{s.repo}</div>
                <div className="text-xs text-muted">
                  {s.options.types.join(", ")} - {s.triggerCount} trigger{s.triggerCount === 1 ? "" : "s"} - last {fmt(s.lastTriggeredAt)}
                </div>
              </div>
              <button className={btn} onClick={() => remove(s.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function DevPortal() {
  const [origin, setOrigin] = useState("https://your-app.vercel.app");
  useEffect(() => setOrigin(window.location.origin), []);
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Developers</h1>
        <p className="max-w-3xl text-muted">
          Integrate RepoScribe into your own tools: API key authentication, JSON endpoints, signed webhooks and GitHub auto-sync. Full reference on the{" "}
          <a href="/docs" className="text-accent underline">
            API Docs
          </a>{" "}
          page.
        </p>
      </header>
      <KeySection origin={origin} />
      <WebhooksSection />
      <SyncSection />
    </div>
  );
}
