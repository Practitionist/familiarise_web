"use client";

import { Button } from "@/components/ui/button";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startIndex: number;
  endIndex: number;
  onPageChange: (page: number) => void;
  onNextPage: () => void;
  onPreviousPage: () => void;
  onFirstPage: () => void;
  onLastPage: () => void;
  showPageNumbers?: boolean;
  maxVisiblePages?: number;
}

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  hasNextPage,
  hasPreviousPage,
  startIndex,
  endIndex,
  onPageChange,
  onNextPage,
  onPreviousPage,
  onFirstPage,
  onLastPage,
  showPageNumbers = true,
  maxVisiblePages = 5,
}: PaginationProps) {
  if (totalPages <= 1) return null;

  // Calculate which page numbers to show
  const getVisiblePages = () => {
    const half = Math.floor(maxVisiblePages / 2);
    let start = Math.max(1, currentPage - half);
    let end = Math.min(totalPages, currentPage + half);

    // Adjust if we're near the beginning or end
    if (end - start + 1 < maxVisiblePages) {
      if (start === 1) {
        end = Math.min(totalPages, start + maxVisiblePages - 1);
      } else {
        start = Math.max(1, end - maxVisiblePages + 1);
      }
    }

    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  };

  const visiblePages = getVisiblePages();

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 py-4">
      {/* Results info */}
      <div className="text-sm text-gray-600">
        Showing {startIndex} to {endIndex} of {totalItems} results
      </div>

      {/* Pagination controls */}
      <div className="flex items-center gap-2">
        {/* First page */}
        <Button
          variant="outline"
          size="sm"
          onClick={onFirstPage}
          disabled={!hasPreviousPage}
          className="px-2"
        >
          ««
        </Button>

        {/* Previous page */}
        <Button
          variant="outline"
          size="sm"
          onClick={onPreviousPage}
          disabled={!hasPreviousPage}
          className="px-3"
        >
          ‹ Prev
        </Button>

        {/* Page numbers */}
        {showPageNumbers && (
          <div className="flex items-center gap-1">
            {/* Show first page if not in visible range */}
            {visiblePages[0] > 1 && (
              <>
                <Button
                  variant={1 === currentPage ? "default" : "outline"}
                  size="sm"
                  onClick={() => onPageChange(1)}
                  className="px-3"
                >
                  1
                </Button>
                {visiblePages[0] > 2 && (
                  <span className="px-2 text-gray-400">...</span>
                )}
              </>
            )}

            {/* Visible page numbers */}
            {visiblePages.map((page) => (
              <Button
                key={page}
                variant={page === currentPage ? "default" : "outline"}
                size="sm"
                onClick={() => onPageChange(page)}
                className="px-3"
              >
                {page}
              </Button>
            ))}

            {/* Show last page if not in visible range */}
            {visiblePages[visiblePages.length - 1] < totalPages && (
              <>
                {visiblePages[visiblePages.length - 1] < totalPages - 1 && (
                  <span className="px-2 text-gray-400">...</span>
                )}
                <Button
                  variant={totalPages === currentPage ? "default" : "outline"}
                  size="sm"
                  onClick={() => onPageChange(totalPages)}
                  className="px-3"
                >
                  {totalPages}
                </Button>
              </>
            )}
          </div>
        )}

        {/* Next page */}
        <Button
          variant="outline"
          size="sm"
          onClick={onNextPage}
          disabled={!hasNextPage}
          className="px-3"
        >
          Next ›
        </Button>

        {/* Last page */}
        <Button
          variant="outline"
          size="sm"
          onClick={onLastPage}
          disabled={!hasNextPage}
          className="px-2"
        >
          »»
        </Button>
      </div>
    </div>
  );
}

// Compact version for smaller spaces
export function CompactPagination({
  currentPage,
  totalPages,
  hasNextPage,
  hasPreviousPage,
  onNextPage,
  onPreviousPage,
}: Pick<
  PaginationProps,
  | "currentPage"
  | "totalPages"
  | "hasNextPage"
  | "hasPreviousPage"
  | "onNextPage"
  | "onPreviousPage"
>) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-center gap-2 py-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onPreviousPage}
        disabled={!hasPreviousPage}
      >
        ‹
      </Button>
      <span className="text-sm text-gray-600 px-2">
        {currentPage} / {totalPages}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onNextPage}
        disabled={!hasNextPage}
      >
        ›
      </Button>
    </div>
  );
}
