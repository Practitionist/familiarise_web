"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/utils/tailwind";

export interface TablePaginationProps {
  /** 1-based. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Offer a page-size picker when both are set. */
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
  className?: string;
}

/**
 * "1–20 of 143" with Prev / Next (#1527 §15), replacing the hand-rolled pagers.
 * The buttons use `aria-disabled` rather than `disabled` so keyboard focus is
 * not dropped when the last page is reached.
 */
export function TablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  pageSizeOptions,
  onPageSizeChange,
  className,
}: Readonly<TablePaginationProps>) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const atStart = page <= 1;
  const atEnd = page >= pageCount;

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground",
        className,
      )}
    >
      <p aria-live="polite" className="tabular-nums">
        {first}–{last} of {total}
      </p>
      <div className="flex items-center gap-2">
        {pageSizeOptions && onPageSizeChange && (
          <Select
            value={String(pageSize)}
            onValueChange={(v) => onPageSizeChange(Number(v))}
          >
            <SelectTrigger className="h-8 w-[88px]" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} / page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled={atStart}
          className={cn(atStart && "cursor-not-allowed opacity-50")}
          onClick={() => !atStart && onPageChange(page - 1)}
        >
          <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
          Prev
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled={atEnd}
          className={cn(atEnd && "cursor-not-allowed opacity-50")}
          onClick={() => !atEnd && onPageChange(page + 1)}
        >
          Next
          <ChevronRight className="ml-1 h-4 w-4" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
