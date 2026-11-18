import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * An unknown back-office path, rendered inside the operator shell by the
 * tree's own boundary. Static markup only, so the server and the browser print
 * the same page; the shell already owns the page's <main>.
 */
export default function BackofficeNotFound() {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold text-foreground">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        This back-office page does not exist.
      </p>
      <Button asChild variant="outline">
        <Link href="/dashboard">Back to your dashboard</Link>
      </Button>
    </div>
  );
}
