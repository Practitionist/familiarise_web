import { BookingCell } from "@/components/dashboard/backoffice/BookingCell";
import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import type { TargetRef } from "@/lib/backoffice/money-list-schemas";

/** What a console action points at: its person and booking, else its kind and id. */
export function TargetCell({
  kind,
  id,
  target,
  basePath,
}: Readonly<{
  kind: string;
  id: string;
  target: TargetRef | null;
  basePath: string;
}>) {
  if (target && (target.person || target.booking)) {
    return (
      <div className="min-w-0 space-y-1">
        {target.person && <PersonCell person={target.person} />}
        {target.booking && (
          <BookingCell booking={target.booking} basePath={basePath} />
        )}
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <p className="text-sm text-foreground">{kind}</p>
      <p
        className="truncate font-mono text-[11px] text-muted-foreground/70"
        title={id}
      >
        {id}
      </p>
    </div>
  );
}
