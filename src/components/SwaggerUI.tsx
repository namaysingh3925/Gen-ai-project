"use client";

import { useEffect, useState } from "react";

const VERSION = "5.35.0";
const BASE = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${VERSION}`;

declare global {
  interface Window {
    SwaggerUIBundle?: (config: Record<string, unknown>) => void;
  }
}

/** Interactive API reference (Swagger UI, pinned version from jsDelivr) fed by /api/v1/openapi.json. */
export function SwaggerUI() {
  const [error, setError] = useState(false);

  useEffect(() => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${BASE}/swagger-ui.css`;
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = `${BASE}/swagger-ui-bundle.js`;
    script.async = true;
    script.onload = () =>
      window.SwaggerUIBundle?.({
        url: "/api/v1/openapi.json",
        dom_id: "#swagger-root",
        deepLinking: true,
        persistAuthorization: true,
        docExpansion: "list",
        defaultModelsExpandDepth: -1,
      });
    script.onerror = () => setError(true);
    document.body.appendChild(script);

    return () => {
      css.remove();
      script.remove();
    };
  }, []);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white text-black">
      {error && (
        <p className="p-6 text-sm">
          Could not load the interactive viewer. The raw specification is available at{" "}
          <a className="underline" href="/api/v1/openapi.json">
            /api/v1/openapi.json
          </a>
          .
        </p>
      )}
      <div id="swagger-root" />
    </div>
  );
}
