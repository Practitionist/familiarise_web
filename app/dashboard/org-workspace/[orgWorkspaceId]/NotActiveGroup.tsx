import type { ReactNode } from "react";

/** Organisations that are not active, collapsed below the active ones and outside every total. */
export function NotActiveGroup({
  count,
  children,
}: Readonly<{ count: number; children: ReactNode }>) {
  return (
    <details className="mt-6 rounded-lg border">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        Not active ({count})
        <span className="ml-2 font-normal text-muted-foreground">
          Deactivated, suspended or awaiting verification; left out of the
          totals above.
        </span>
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}
