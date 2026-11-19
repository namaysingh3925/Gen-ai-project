import http from "node:http";
import type { AddressInfo } from "node:net";

/** Minimal handler context accepted by `authenticate()`. */
export function ctx(headers: Record<string, string> = {}) {
  return {
    req: new Request("http://localhost/api/v1/x", { headers }),
    params: {},
    requestId: "req_test",
    origin: "http://localhost",
    headers: new Headers(),
  } as never;
}

export const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

export function startServer(handler: http.RequestListener) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = http.createServer(handler).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

export async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}
