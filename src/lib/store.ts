/**
 * Tiny key-value abstraction with two backends:
 *  - Upstash Redis over its REST API (production / Vercel) - plain `fetch`, no SDK.
 *  - A local in-memory map persisted to `.data/store.json` (development only).
 * Values are JSON-encoded. Only the operations RepoScribe needs are exposed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "./env";
import { ApiError } from "./http";

export interface KV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, exSeconds?: number): Promise<void>;
  /** Set only if the key does not exist. Returns true when written. */
  setnx(key: string, value: unknown, exSeconds?: number): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Atomic increment; the TTL is applied when the key is created. */
  incr(key: string, exSeconds?: number): Promise<number>;
  /** Push to the head of a list and keep at most `max` entries. */
  lpush(key: string, value: unknown, max?: number): Promise<void>;
  lrange<T>(key: string, start: number, stop: number): Promise<T[]>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  ping(): Promise<boolean>;
}

/* ------------------------------ Upstash (REST) ------------------------------ */

type Arg = string | number;

class UpstashKV implements KV {
  constructor(private url: string, private token: string) {}

  private async request<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new ApiError(503, "store_unavailable", "The data store is unreachable. Try again shortly.");
    }
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      console.error("[store] upstash error", res.status);
      throw new ApiError(503, "store_unavailable", "The data store returned an error. Try again shortly.");
    }
    return data as T;
  }

  private async cmd<T = unknown>(...args: Arg[]): Promise<T> {
    const data = await this.request<{ result?: T; error?: string }>("", args);
    if (data.error) {
      console.error("[store] command failed:", data.error);
      throw new ApiError(503, "store_unavailable", "The data store rejected a command.");
    }
    return data.result as T;
  }

  private async pipeline(cmds: Arg[][]): Promise<void> {
    await this.request("/pipeline", cmds);
  }

  async get<T>(key: string) {
    const raw = await this.cmd<string | null>("GET", key);
    return raw == null ? null : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown, exSeconds?: number) {
    const args: Arg[] = ["SET", key, JSON.stringify(value)];
    if (exSeconds) args.push("EX", exSeconds);
    await this.cmd(...args);
  }
  async setnx(key: string, value: unknown, exSeconds?: number) {
    const args: Arg[] = ["SET", key, JSON.stringify(value), "NX"];
    if (exSeconds) args.push("EX", exSeconds);
    return (await this.cmd<string | null>(...args)) === "OK";
  }
  async del(key: string) {
    await this.cmd("DEL", key);
  }
  async incr(key: string, exSeconds?: number) {
    const n = await this.cmd<number>("INCR", key);
    if (n === 1 && exSeconds) await this.cmd("EXPIRE", key, exSeconds);
    return n;
  }
  async lpush(key: string, value: unknown, max = 50) {
    await this.pipeline([
      ["LPUSH", key, JSON.stringify(value)],
      ["LTRIM", key, 0, max - 1],
    ]);
  }
  async lrange<T>(key: string, start: number, stop: number) {
    const raw = (await this.cmd<string[]>("LRANGE", key, start, stop)) ?? [];
    return raw.map((r) => JSON.parse(r) as T);
  }
  async sadd(key: string, member: string) {
    await this.cmd("SADD", key, member);
  }
  async srem(key: string, member: string) {
    await this.cmd("SREM", key, member);
  }
  async smembers(key: string) {
    return (await this.cmd<string[]>("SMEMBERS", key)) ?? [];
  }
  async ping() {
    return (await this.cmd<string>("PING")) === "PONG";
  }
}

/* ---------------------------- Local (development) ---------------------------- */

interface Persisted {
  strings: [string, { v: string; exp: number | null }][];
  lists: [string, string[]][];
  sets: [string, string[]][];
}

class LocalKV implements KV {
  private strings = new Map<string, { v: string; exp: number | null }>();
  private lists = new Map<string, string[]>();
  private sets = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private file: string | null) {
    if (file) this.load(file);
  }

  private load(file: string) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Persisted;
      this.strings = new Map(data.strings);
      this.lists = new Map(data.lists);
      this.sets = new Map(data.sets.map(([k, v]) => [k, new Set(v)]));
    } catch {
      /* first run or unreadable file: start empty */
    }
  }

  private save() {
    if (!this.file || this.timer) return;
    const file = this.file;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        mkdirSync(dirname(file), { recursive: true });
        const data: Persisted = {
          strings: [...this.strings],
          lists: [...this.lists],
          sets: [...this.sets].map(([k, v]) => [k, [...v]]),
        };
        writeFileSync(file, JSON.stringify(data));
      } catch {
        /* best effort in dev */
      }
    }, 150);
    this.timer.unref?.();
  }

  private live(key: string) {
    const e = this.strings.get(key);
    if (!e) return null;
    if (e.exp !== null && e.exp < Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return e;
  }

  async get<T>(key: string) {
    const e = this.live(key);
    return e ? (JSON.parse(e.v) as T) : null;
  }
  async set(key: string, value: unknown, exSeconds?: number) {
    this.strings.set(key, { v: JSON.stringify(value), exp: exSeconds ? Date.now() + exSeconds * 1000 : null });
    this.save();
  }
  async setnx(key: string, value: unknown, exSeconds?: number) {
    if (this.live(key)) return false;
    await this.set(key, value, exSeconds);
    return true;
  }
  async del(key: string) {
    this.strings.delete(key);
    this.lists.delete(key);
    this.sets.delete(key);
    this.save();
  }
  async incr(key: string, exSeconds?: number) {
    const e = this.live(key);
    const n = (e ? Number(JSON.parse(e.v)) : 0) + 1;
    this.strings.set(key, { v: JSON.stringify(n), exp: e ? e.exp : exSeconds ? Date.now() + exSeconds * 1000 : null });
    this.save();
    return n;
  }
  async lpush(key: string, value: unknown, max = 50) {
    const list = this.lists.get(key) ?? [];
    list.unshift(JSON.stringify(value));
    this.lists.set(key, list.slice(0, max));
    this.save();
  }
  async lrange<T>(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start, end).map((r) => JSON.parse(r) as T);
  }
  async sadd(key: string, member: string) {
    const s = this.sets.get(key) ?? new Set<string>();
    s.add(member);
    this.sets.set(key, s);
    this.save();
  }
  async srem(key: string, member: string) {
    this.sets.get(key)?.delete(member);
    this.save();
  }
  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }
  async ping() {
    return true;
  }
}

/* --------------------------------- selector --------------------------------- */

const g = globalThis as unknown as { __rsKv?: KV; __rsKvKind?: string };

export function storeKind(): "upstash" | "local" | "missing" {
  if (env.redisUrl && env.redisToken) return "upstash";
  if (env.onVercel) return "missing";
  return "local";
}

export function kv(): KV {
  const kind = storeKind();
  if (kind === "missing") {
    throw new ApiError(
      503,
      "store_not_configured",
      "No data store is configured. Add an Upstash Redis integration (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) to this deployment.",
    );
  }
  if (!g.__rsKv || g.__rsKvKind !== kind) {
    g.__rsKvKind = kind;
    g.__rsKv =
      kind === "upstash"
        ? new UpstashKV(env.redisUrl, env.redisToken)
        : new LocalKV(process.env.NODE_ENV === "test" ? null : join(process.cwd(), ".data", "store.json"));
  }
  return g.__rsKv;
}

/** Test helper: drop the singleton so each test file starts with an empty store. */
export function resetStoreForTests() {
  g.__rsKv = undefined;
  g.__rsKvKind = undefined;
}
