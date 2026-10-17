import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * #1780 R-2 — the app-wide not-found page: clean, elevated card with clear
 * recovery paths back to Home or Explore Experts.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-elevation-2">
        <div className="mx-auto mb-4 inline-flex items-center rounded-full border border-border bg-muted px-3 py-1 font-mono text-xs font-medium text-muted-foreground">
          404
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page does not exist, or you do not have access to it.
        </p>
        <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:justify-center">
          <Button asChild>
            <Link href="/">Return Home</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/explore/experts">Explore Experts</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
