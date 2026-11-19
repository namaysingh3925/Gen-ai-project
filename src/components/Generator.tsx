"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiClientError, describeError, downloadText, type JobSummary, type JobView } from "@/lib/client";
import { DOC_TYPES, STYLES, type DocType, type Style } from "@/lib/types";
import { Markdown } from "./Markdown";

const TYPE_META: Record<DocType, { file: string; blurb: string }> = {
  readme: { file: "README.md", blurb: "Overview, install, usage" },
  architecture: { file: "ARCHITECTURE.md", blurb: "Components + diagram" },
  api: { file: "API.md", blurb: "Endpoints, CLI or functions" },
  contributing: { file: "CONTRIBUTING.md", blurb: "Dev setup & PR flow" },
  changelog: { file: "CHANGELOG.md", blurb: "From recent commits" },
};

const STYLE_LABEL: Record<Style, string> = {
  concise: "Concise",
  standard: "Standard",
  detailed: "Detailed",
  beginner: "Beginner-friendly",
};

const EXAMPLES = ["expressjs/express", "pallets/flask", "octocat/Hello-World"];
const LANG_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#8b5cf6", "#ef4444", "#14b8a6"];

function ScoreRing({ score, label }: { score: number | null; label: string }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = score ?? 0;
  const color = pct >= 90 ? "#10b981" : pct >= 75 ? "#84cc16" : pct >= 55 ? "#f59e0b" : "#ef4444";
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={`${label}: ${score ?? "not available"}${score !== null ? " out of 100" : ""}`}>
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--border)" strokeWidth="6" />
        {score !== null && (
          <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 32 32)" />
        )}
        <text x="32" y="37" textAnchor="middle" fontSize="16" fontWeight="700" fill="currentColor">
          {score ?? "-"}
        </text>
      </svg>
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-line bg-accent-soft px-2.5 py-0.5 text-xs text-ink">{children}</span>;
}

function Progress({ job }: { job: JobView }) {
  const pct = Math.round((job.progress.completed / Math.max(1, job.progress.total)) * 100);
  return (
    <section className="rounded-xl border border-line bg-surface p-5" aria-live="polite">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-medium">{job.progress.step}</span>
        <span className="text-muted">{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-accent-soft" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${Math.max(pct, 6)}%` }} />
      </div>
      <p className="mt-3 text-xs text-muted">
        {job.repo.fullName} - generating {job.options.types.map((t) => TYPE_META[t].file).join(", ")}. This usually takes 10-40 seconds.
      </p>
    </section>
  );
}

export function Generator() {
  const [repoUrl, setRepoUrl] = useState("");
  const [types, setTypes] = useState<DocType[]>(["readme", "architecture"]);
  const [style, setStyle] = useState<Style>("standard");
  const [language, setLanguage] = useState("English");
  const [token, setToken] = useState("");
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DocType>("readme");
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<JobSummary[]>([]);
  const [instruction, setInstruction] = useState("");
  const [refining, setRefining] = useState(false);
  const alive = useRef(true);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api<{ data: JobSummary[] }>("/api/v1/docs?limit=12");
      if (alive.current) setHistory(res.data);
    } catch {
      /* history is a nicety; ignore failures */
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const poll = useCallback(async (id: string): Promise<JobView> => {
    const POLL_MS = 2500; // ~24 requests/minute: well inside the per-key rate limit
    let failures = 0;
    let wait = POLL_MS;
    const deadline = Date.now() + 5 * 60_000;
    while (alive.current && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, wait));
      wait = POLL_MS;
      try {
        const j = await api<JobView>(`/api/v1/docs/${id}`);
        if (!alive.current) break;
        setJob(j);
        failures = 0;
        if (j.status === "completed" || j.status === "failed") return j;
      } catch (e) {
        // Rate limited: back off as the server asks and keep waiting - the job itself is still running.
        if (e instanceof ApiClientError && e.status === 429) {
          wait = Math.min(30, e.retryAfter ?? 5) * 1000;
          continue;
        }
        if (++failures >= 4) throw e;
      }
    }
    throw new Error("Timed out waiting for the document set.");
  }, []);

  const firstDoc = (j: JobView): DocType => DOC_TYPES.find((t) => j.documents[t]) ?? "readme";

  async function generate(e?: FormEvent) {
    e?.preventDefault();
    if (!repoUrl.trim() || !types.length || busy) return;
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const created = await api<JobView>("/api/v1/generate", {
        method: "POST",
        json: { repoUrl: repoUrl.trim(), types, style, language: language.trim() || "English", async: true },
        githubToken: token,
      });
      setJob(created);
      const done = await poll(created.id);
      if (done.status === "failed") setError(done.error?.message ?? "Generation failed.");
      else {
        setTab(firstDoc(done));
        setRaw(false);
        setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
      }
      void loadHistory();
    } catch (err) {
      setError(describeError(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function openFromHistory(id: string) {
    setError(null);
    try {
      const j = await api<JobView>(`/api/v1/docs/${id}`);
      setJob(j);
      setTab(firstDoc(j));
      setRaw(false);
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function refine() {
    if (!job || instruction.trim().length < 3 || refining) return;
    setRefining(true);
    setError(null);
    try {
      setJob(await api<JobView>(`/api/v1/docs/${job.id}/refine`, { method: "POST", json: { type: activeTab, instruction: instruction.trim() } }));
      setInstruction("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRefining(false);
    }
  }

  const toggleType = (t: DocType) =>
    setTypes((cur) => (cur.includes(t) ? (cur.length > 1 ? cur.filter((x) => x !== t) : cur) : [...cur, t]));

  const docs = job ? DOC_TYPES.filter((t) => job.documents[t]) : [];
  const activeTab: DocType = docs.includes(tab) ? tab : (docs[0] ?? "readme");
  const current = job?.documents[activeTab];
  const finished = job?.status === "completed" && docs.length > 0;
  const suggestions = job?.health?.after?.checks.filter((c) => !c.passed) ?? [];

  async function copy() {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard access was denied - use Download instead.");
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3 pt-2">
        <h1 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">
          Turn any GitHub repo into <span className="text-accent">documentation people actually read</span>
        </h1>
        <p className="max-w-2xl text-muted">
          Paste a repository link. RepoScribe reads the code, then Gemini writes a README, architecture guide with a diagram, API reference, contributing guide or changelog - and scores the README before and after.
        </p>
      </section>

      <form onSubmit={generate} className="space-y-5 rounded-xl border border-line bg-surface p-5 shadow-sm">
        <div>
          <label htmlFor="repo" className="mb-1.5 block text-sm font-medium">
            GitHub repository
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              autoComplete="off"
              spellCheck={false}
              required
              className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3.5 py-2.5 text-sm outline-none focus:border-accent"
            />
            <button
              type="submit"
              disabled={busy || !repoUrl.trim()}
              className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Generating..." : "Generate docs"}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Try:{" "}
            {EXAMPLES.map((ex, i) => (
              <span key={ex}>
                <button type="button" onClick={() => setRepoUrl(`https://github.com/${ex}`)} className="text-accent underline-offset-2 hover:underline">
                  {ex}
                </button>
                {i < EXAMPLES.length - 1 ? ", " : ""}
              </span>
            ))}
          </p>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">What to generate</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {DOC_TYPES.map((t) => {
              const on = types.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggleType(t)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${on ? "border-accent bg-accent-soft" : "border-line hover:border-accent/60"}`}
                >
                  <span className="block text-sm font-medium">{TYPE_META[t].file}</span>
                  <span className="block text-xs text-muted">{TYPE_META[t].blurb}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="style" className="mb-1.5 block text-sm font-medium">
              Style
            </label>
            <select id="style" value={style} onChange={(e) => setStyle(e.target.value as Style)} className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm">
              {STYLES.map((s) => (
                <option key={s} value={s}>
                  {STYLE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="lang" className="mb-1.5 block text-sm font-medium">
              Language
            </label>
            <input id="lang" value={language} onChange={(e) => setLanguage(e.target.value)} list="langs" maxLength={40} className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm" />
            <datalist id="langs">
              {["English", "Hindi", "Kannada", "Spanish", "French", "German", "Japanese", "Portuguese"].map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </div>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">Private repository?</summary>
          <div className="mt-2 space-y-1">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="GitHub personal access token (read-only)"
              autoComplete="off"
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm"
              aria-label="GitHub personal access token"
            />
            <p className="text-xs text-muted">Sent only with this request to read the repository. It is never stored or logged.</p>
          </div>
        </details>
      </form>

      {error && (
        <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {busy && job && job.status !== "completed" && job.status !== "failed" && <Progress job={job} />}
      {busy && !job && <div className="animate-pulse rounded-xl border border-line bg-surface p-5 text-sm text-muted">Submitting...</div>}

      {finished && job && current && (
        <div ref={resultsRef} className="scroll-mt-20 space-y-5">
          <section className="flex flex-wrap items-center gap-6 rounded-xl border border-line bg-surface p-5">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <a href={job.repo.url} target="_blank" rel="noopener noreferrer" className="truncate text-lg font-semibold text-accent hover:underline">
                  {job.repo.fullName}
                </a>
                {job.cached && <Chip>served from cache</Chip>}
                {job.warnings.length > 0 && <Chip>partial</Chip>}
              </div>
              {job.repo.description && <p className="text-sm text-muted">{job.repo.description}</p>}
              <div className="flex flex-wrap gap-1.5 text-xs text-muted">
                {job.repo.branch && <span>branch {job.repo.branch}</span>}
                {job.repo.language && <span>- {job.repo.language}</span>}
                {job.repo.license && <span>- {job.repo.license}</span>}
                {typeof job.repo.stars === "number" && <span>- {job.repo.stars.toLocaleString()} stars</span>}
                {job.usage.durationMs > 0 && <span>- {(job.usage.durationMs / 1000).toFixed(1)}s</span>}
                {job.usage.outputTokens > 0 && <span>- {(job.usage.promptTokens + job.usage.outputTokens).toLocaleString()} tokens</span>}
              </div>
              {job.analysis && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {job.analysis.stack.slice(0, 10).map((s) => (
                    <Chip key={s}>{s}</Chip>
                  ))}
                </div>
              )}
            </div>
            {job.health && (job.health.before || job.health.after) && (
              <div className="flex items-center gap-3" aria-label="README health score">
                <ScoreRing score={job.health.before?.score ?? 0} label="README before" />
                <span aria-hidden className="text-muted">
                  &rarr;
                </span>
                <ScoreRing score={job.health.after?.score ?? null} label="after" />
              </div>
            )}
          </section>

          {job.analysis && job.analysis.languages.length > 0 && (
            <section className="rounded-xl border border-line bg-surface p-5">
              <div className="mb-2 flex h-2.5 overflow-hidden rounded-full" role="img" aria-label="Language breakdown">
                {job.analysis.languages.map((l, i) => (
                  <div key={l.name} style={{ width: `${l.percent}%`, background: LANG_COLORS[i % LANG_COLORS.length] }} title={`${l.name} ${l.percent}%`} />
                ))}
              </div>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                {job.analysis.languages.map((l, i) => (
                  <li key={l.name} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: LANG_COLORS[i % LANG_COLORS.length] }} />
                    {l.name} {l.percent}%
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                Analysed {job.analysis.analyzedFiles.length} of {job.analysis.fileCount.toLocaleString()} files
                {job.analysis.treeTruncated ? " (repository tree was truncated by GitHub)" : ""}.
              </p>
            </section>
          )}

          {job.warnings.length > 0 && (
            <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
              <b>Some documents were skipped:</b>
              <ul className="ml-5 list-disc">
                {job.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <section className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
              <div role="tablist" aria-label="Generated documents" className="flex flex-wrap gap-1">
                {docs.map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={t === activeTab}
                    onClick={() => setTab(t)}
                    className={`rounded-md px-3 py-1.5 text-sm ${t === activeTab ? "bg-accent-soft font-medium text-accent" : "text-muted hover:text-ink"}`}
                  >
                    {TYPE_META[t].file}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1 text-sm">
                <button onClick={() => setRaw(!raw)} className="rounded-md px-2.5 py-1.5 text-muted hover:text-ink">
                  {raw ? "Preview" : "Markdown"}
                </button>
                <button onClick={copy} className="rounded-md px-2.5 py-1.5 text-muted hover:text-ink">
                  {copied ? "Copied!" : "Copy"}
                </button>
                <button onClick={() => downloadText(TYPE_META[activeTab].file, current.markdown)} className="rounded-md px-2.5 py-1.5 text-muted hover:text-ink">
                  Download
                </button>
                {docs.length > 1 && (
                  <button
                    onClick={() => downloadText(`${job.repo.fullName.replace("/", "-")}-docs.md`, docs.map((t) => job.documents[t]!.markdown).join("\n\n---\n\n"))}
                    className="rounded-md px-2.5 py-1.5 text-muted hover:text-ink"
                  >
                    Download all
                  </button>
                )}
              </div>
            </div>
            <div className="max-h-[70vh] overflow-auto p-5 sm:p-7">
              {raw ? <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{current.markdown}</pre> : <Markdown>{current.markdown}</Markdown>}
            </div>
            <div className="border-t border-line p-3">
              <label htmlFor="refine" className="sr-only">
                Refine this document
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="refine"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void refine()}
                  maxLength={500}
                  placeholder={`Refine ${TYPE_META[activeTab].file}: "make the install section shorter", "add a troubleshooting section"...`}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
                />
                <button onClick={() => void refine()} disabled={refining || instruction.trim().length < 3} className="rounded-lg border border-accent px-4 py-2 text-sm font-medium text-accent hover:bg-accent-soft disabled:opacity-50">
                  {refining ? "Refining..." : "Refine"}
                </button>
              </div>
            </div>
          </section>

          {suggestions.length > 0 && activeTab === "readme" && (
            <details className="rounded-xl border border-line bg-surface p-4 text-sm">
              <summary className="cursor-pointer font-medium">README health: {suggestions.length} suggestion{suggestions.length > 1 ? "s" : ""} left</summary>
              <ul className="mt-2 ml-5 list-disc space-y-1 text-muted">
                {suggestions.map((s) => (
                  <li key={s.id}>
                    <b className="text-ink">{s.label}:</b> {s.hint}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {history.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Recent generations</h2>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {history.map((h) => (
              <li key={h.id}>
                <button onClick={() => void openFromHistory(h.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-accent-soft">
                  <span className="min-w-0 truncate font-medium">{h.repo.fullName}</span>
                  <span className="flex shrink-0 items-center gap-3 text-xs text-muted">
                    <span>{h.types.join(", ")}</span>
                    {h.health?.after != null && (
                      <span>
                        {h.health.before ?? 0} &rarr; {h.health.after}
                      </span>
                    )}
                    <span className={h.status === "failed" ? "text-red-500" : ""}>{h.status}</span>
                    <time dateTime={h.createdAt}>{new Date(h.createdAt).toLocaleDateString()}</time>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
