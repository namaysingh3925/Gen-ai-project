/**
 * HTTP plumbing shared by every API route: error envelope, request ids, CORS,
 * JSON body parsing/validation and a `route()` wrapper that turns thrown ApiErrors
 * into well-formed JSON responses with correct status codes.
 */
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { env } from "./env";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key, X-GitHub-Token",
  "Access-Control-Expose-Headers":
    "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, Location",
  "Access-Control-Max-Age": "86400",
};

export interface Ctx<P = Record<string, string>> {
  req: NextRequest;
  params: P;
  requestId: string;
  origin: string;
  /** Extra response headers (e.g. rate-limit headers) merged into the final response. */
  headers: Headers;
}

export function json(data: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(data, { status, headers });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

export function getOrigin(req: Request): string {
  if (env.publicBaseUrl) return env.publicBaseUrl;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
  }
  return new URL(req.url).origin;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

function errorResponse(e: unknown, requestId: string): Response {
  if (e instanceof ApiError) {
    return NextResponse.json(
      { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) }, requestId },
      { status: e.status, headers: e.headers },
    );
  }
  console.error(`[${requestId}] unhandled error`, e instanceof Error ? e.stack : e);
  return NextResponse.json(
    { error: { code: "internal_error", message: "An unexpected error occurred." }, requestId },
    { status: 500 },
  );
}

/** Wrap a handler: request id, CORS, no-store caching, uniform error responses. */
export function route<P = Record<string, string>>(handler: (c: Ctx<P>) => Promise<Response>) {
  return async (req: NextRequest, rc?: { params: Promise<P> }): Promise<Response> => {
    const requestId = `req_${randomBytes(8).toString("hex")}`;
    const headers = new Headers();
    let res: Response;
    try {
      const params = rc?.params ? await rc.params : ({} as P);
      res = await handler({ req, params, requestId, origin: getOrigin(req), headers });
    } catch (e) {
      res = errorResponse(e, requestId);
    }
    for (const [k, v] of headers) res.headers.set(k, v);
    res.headers.set("X-Request-Id", requestId);
    if (!res.headers.has("Cache-Control")) res.headers.set("Cache-Control", "no-store");
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  };
}

const MAX_BODY_BYTES = 1_000_000;

/** Parse + validate a JSON body. 400 for malformed JSON, 413 if too large, 422 for schema errors. */
export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large", "Request body exceeds 1 MB.");
  let data: unknown = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
    }
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "validation_error",
      "The request body failed validation.",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}

export const noContent = (headers?: Record<string, string>) => new NextResponse(null, { status: 204, headers });
