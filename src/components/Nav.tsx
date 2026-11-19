"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Generator" },
  { href: "/developers", label: "Developers" },
  { href: "/docs", label: "API Docs" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-sm font-bold text-white" aria-hidden>
            R
          </span>
          RepoScribe
        </Link>
        <nav className="flex items-center gap-1 text-sm" aria-label="Main">
          {links.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 transition-colors ${active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:text-ink"}`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
