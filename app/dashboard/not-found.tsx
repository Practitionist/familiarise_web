import Link from "next/link";

import { Button } from "@/components/ui/button";

/** Unknown segments and ids rejected by a role-root layout land here with a real 404; deep pages below a loading.tsx still soft-404. */
export default function DashboardNotFound() {
  return (
    <main className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold text-foreground">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        This page does not exist, or it is not one of yours.
      </p>
      <Button asChild variant="outline">
        <Link href="/dashboard">Back to your dashboard</Link>
      </Button>
    </main>
  );
}
