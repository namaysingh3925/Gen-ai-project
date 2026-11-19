"use client";

import { useEffect, useId, useState } from "react";

/** Renders a Mermaid diagram client-side; falls back to the source if the LLM's syntax is invalid. */
export function Mermaid({ chart }: { chart: string }) {
  const id = `mmd${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
        const valid = await mermaid.parse(chart, { suppressErrors: true });
        if (!valid) throw new Error("invalid diagram");
        const out = await mermaid.render(id, chart);
        if (!cancelled) setSvg(out.svg);
      } catch {
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (failed) {
    return (
      <figure className="not-prose my-4">
        <pre className="overflow-x-auto rounded-lg border border-line bg-surface p-3 text-xs">{chart}</pre>
        <figcaption className="mt-1 text-xs text-muted">Diagram source (could not be rendered - paste it into mermaid.live to tweak).</figcaption>
      </figure>
    );
  }
  if (!svg) {
    return <div className="not-prose my-4 animate-pulse rounded-lg border border-line bg-surface p-6 text-center text-xs text-muted">Rendering diagram...</div>;
  }
  return (
    <div
      className="not-prose my-4 overflow-x-auto rounded-lg border border-line bg-surface p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      role="img"
      aria-label="Architecture diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
