import type { Metadata } from "next";
import { DevPortal } from "@/components/DevPortal";

export const metadata: Metadata = { title: "Developers - RepoScribe" };

export default function DevelopersPage() {
  return <DevPortal />;
}
