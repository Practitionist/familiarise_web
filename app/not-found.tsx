import Link from "next/link";
import { connection } from "next/server";

import { Button } from "@/components/ui/button";

/**
 * The app-wide not-found page, rendered per request: a prerendered copy reads
 * `/_not-found` as its path, so chrome hidden by path would differ on hydration.
 */
export default async function NotFound() {
  await connection();
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
