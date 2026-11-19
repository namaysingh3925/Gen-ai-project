import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "RepoScribe - GitHub Repository Documentation Generator",
  description:
    "Turn any GitHub repository into a polished README, architecture guide, API reference and changelog with Gemini. Includes a documented REST API, API keys and signed webhooks.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-ink antialiased">
        <Nav />
        <main className="mx-auto w-full max-w-5xl px-4 pb-20 pt-8 sm:px-6">{children}</main>
        <footer className="border-t border-line py-6 text-center text-xs text-muted">
          RepoScribe - GenAI Applications CIA-P project. Documentation drafted by Gemini; always review before publishing.
        </footer>
      </body>
    </html>
  );
}
