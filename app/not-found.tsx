import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * #1780 R-2 — the app-wide not-found page: plain and monochrome, with one way
 * back, so a notFound() anywhere never falls through to a crash screen.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold text-foreground">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        This page does not exist, or you do not have access to it.
      </p>
      <Button asChild variant="outline">
        <Link href="/">Go to the home page</Link>
      </Button>
    </main>
  );
}
