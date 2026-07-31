import { Monitor } from "lucide-react";

/**
 * Gate for surfaces that genuinely need a wide viewport — the slot heatmap is
 * seven day-columns of 30-minute rows, which does not survive a phone.
 *
 * CSS-only on purpose. Detecting the viewport in JS would either render the
 * wrong branch on the server and correct it after hydration (a visible flash,
 * and a hydration mismatch), or force the whole page to be client-only. Two
 * siblings and a Tailwind breakpoint have neither problem: the browser picks
 * before first paint and there is nothing to reconcile.
 */
export function DesktopOnlyNotice({
  children,
  className,
}: Readonly<{ children: React.ReactNode; className?: string }>) {
  return (
    <>
      <div className="lg:hidden flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-16 text-center">
        <Monitor className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-foreground">
          Please access this on desktop for now
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Choosing times needs a wider screen than this one. Everything else in
          your dashboard works here.
        </p>
      </div>

      <div className={`hidden lg:block ${className ?? ""}`}>{children}</div>
    </>
  );
}
