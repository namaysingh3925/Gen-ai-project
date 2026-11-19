import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");

export const hmacSha256 = (secret: string, data: string) =>
  createHmac("sha256", secret).update(data).digest("hex");

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const randomToken = (bytes = 24) => randomBytes(bytes).toString("base64url");

/** Prefixed random identifier, e.g. `doc_Zk3k...`. */
export const newId = (prefix: string, bytes = 9) => `${prefix}_${randomBytes(bytes).toString("base64url")}`;
