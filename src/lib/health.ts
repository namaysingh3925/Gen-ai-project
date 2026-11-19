/**
 * Deterministic "README health" rubric (no LLM involved). Scores 0-100 and tells the author
 * exactly what is missing. We score the existing README ("before") and the generated one ("after").
 */
import type { Health, HealthCheck } from "./types";

const has = (text: string, re: RegExp) => re.test(text);

function headings(md: string): string {
  return (md.match(/^#{1,6}\s+.+$/gm) ?? []).join("\n");
}

export function scoreReadme(markdown: string | null | undefined): Health {
  const md = (markdown ?? "").trim();
  const h = headings(md);
  const codeBlocks = (md.match(/```/g) ?? []).length / 2;
  const prose = md.replace(/```[\s\S]*?```/g, "").replace(/^#.*$/gm, "").replace(/!?\[[^\]]*\]\([^)]*\)/g, "").trim();

  const checks: HealthCheck[] = [
    { id: "exists", label: "README exists", weight: 8, passed: md.length > 0, hint: "Add a README.md at the repository root." },
    { id: "title", label: "Has a title (H1)", weight: 5, passed: has(md, /^#\s+\S/m), hint: "Start with a single `# Project Name` heading." },
    { id: "description", label: "Explains what the project does", weight: 10, passed: prose.length >= 120, hint: "Add a short paragraph describing the purpose and who it is for." },
    { id: "install", label: "Installation / getting started", weight: 15, passed: has(h, /install|getting started|setup|set up|quick ?start/i), hint: "Add an Installation or Getting Started section with exact commands." },
    { id: "usage", label: "Usage with examples", weight: 15, passed: has(h, /usage|example|how to use|demo/i) && codeBlocks >= 1, hint: "Show a runnable usage example in a code block." },
    { id: "code", label: "Code blocks for commands", weight: 5, passed: codeBlocks >= 2, hint: "Put shell commands and snippets in fenced code blocks." },
    { id: "features", label: "Features / overview", weight: 5, passed: has(h, /feature|overview|about|highlights|why/i), hint: "List the key features." },
    { id: "stack", label: "Tech stack or requirements", weight: 5, passed: has(h, /tech|built with|stack|requirement|prerequisite|dependenc/i), hint: "State prerequisites and the main technologies." },
    { id: "config", label: "Configuration / environment", weight: 5, passed: has(md, /\.env|environment variable|configuration|config\b/i), hint: "Document configuration and environment variables." },
    { id: "badges", label: "Status badges", weight: 5, passed: has(md, /img\.shields\.io|badge/i), hint: "Add build, license or version badges." },
    { id: "license", label: "License mentioned", weight: 5, passed: has(md, /licen[sc]e/i), hint: "State the license." },
    { id: "contributing", label: "Contribution guidance", weight: 5, passed: has(md, /contribut/i), hint: "Explain how others can contribute." },
    { id: "structure", label: "Structure / API / architecture", weight: 5, passed: has(h, /structure|architecture|api|endpoint|layout|folder/i), hint: "Describe the project layout or public API." },
    { id: "length", label: "Sufficient detail", weight: 7, passed: md.length >= 800, hint: "A README under ~800 characters is rarely enough." },
  ];

  const score = checks.reduce((s, c) => s + (c.passed ? c.weight : 0), 0);
  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 55 ? "C" : score >= 35 ? "D" : "F";
  return { score, grade, checks };
}
