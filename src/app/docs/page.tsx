import type { Metadata } from "next";
import Link from "next/link";
import { SwaggerUI } from "@/components/SwaggerUI";

export const metadata: Metadata = { title: "API Docs - RepoScribe" };

export default function DocsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">API documentation</h1>
        <p className="max-w-3xl text-muted">
          Everything the web app does is available over a documented REST API. Create a key on the{" "}
          <Link href="/developers" className="text-accent underline">
            Developers
          </Link>{" "}
          page, click <b>Authorize</b> below, paste it, and use <b>Try it out</b>. Machine-readable spec:{" "}
          <a href="/api/v1/openapi.json" className="text-accent underline">
            openapi.json
          </a>
          .
        </p>
      </header>
      <SwaggerUI />
    </div>
  );
}
