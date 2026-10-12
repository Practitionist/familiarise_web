"use client";

import { Fragment, useId, useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/utils/tailwind";

export interface LibraryColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
}

/**
 * A library table whose rows may expand into a detail panel (a thread's
 * versions, a session's parts). The toggle is a disclosure button with
 * `aria-expanded` and `aria-controls`; expanded rows are local state.
 */
export function LibraryTable<T>({
  caption,
  columns,
  rows,
  getRowId,
  detail,
  detailLabel,
}: Readonly<{
  caption: string;
  columns: LibraryColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  /** The expanded panel; rows that return null have no toggle. */
  detail?: (row: T) => ReactNode | null;
  detailLabel?: (row: T) => string;
}>) {
  const base = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandable = Boolean(detail);

  return (
    <div className="overflow-x-auto">
      <Table>
        <caption className="sr-only">{caption}</caption>
        <TableHeader>
          <TableRow>
            {expandable && (
              <TableHead className="w-10">
                <span className="sr-only">Details</span>
              </TableHead>
            )}
            {columns.map((column) => (
              <TableHead key={column.key} className={column.className}>
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => {
            const id = getRowId(row);
            const panel = detail?.(row) ?? null;
            const expanded = panel !== null && open.has(id);
            const panelId = `${base}-detail-${index}`;
            return (
              <Fragment key={id}>
                <TableRow className={cn(expanded && "border-b-0")}>
                  {expandable && (
                    <TableCell className="w-10 align-top">
                      {panel !== null && (
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={panelId}
                          aria-label={detailLabel?.(row) ?? "Show details"}
                          onClick={() => toggle(id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <ChevronRight
                            className={cn(
                              "h-4 w-4 transition-transform",
                              expanded && "rotate-90",
                            )}
                            aria-hidden
                          />
                        </button>
                      )}
                    </TableCell>
                  )}
                  {columns.map((column) => (
                    <TableCell
                      key={column.key}
                      className={cn("align-top", column.className)}
                    >
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
                {panel !== null && (
                  <TableRow
                    id={panelId}
                    hidden={!expanded}
                    className="bg-muted/30 hover:bg-muted/30"
                  >
                    <TableCell colSpan={columns.length + 1} className="py-2">
                      {panel}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export const formatLibraryDate = (iso: string | null) =>
  iso ? DATE.format(new Date(iso)) : "—";

/** An icon link that opens a file in a new tab. */
export function OpenFileLink({
  href,
  label,
}: Readonly<{ href: string; label: string }>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label} (opens in a new tab)`}
      title={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ExternalLink className="h-4 w-4" aria-hidden />
    </a>
  );
}
