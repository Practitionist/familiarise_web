import Link from "next/link";

import { Button } from "@/components/ui/button";

/** A record that is missing, or belongs to another learner, lands here instead of crashing. */
export default function ConsulteeNotFound() {
  return (
    <main className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold text-foreground">Not found</h1>
      <p className="text-sm text-muted-foreground">
        This page no longer exists, or it is not one of yours.
      </p>
      <Button asChild variant="outline">
        <Link href="/dashboard">Back to your dashboard</Link>
      </Button>
    </main>
  );
}
