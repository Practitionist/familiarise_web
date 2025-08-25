"use client";

import { usePagination } from "@/hooks/usePagination";
import { CompactPagination } from "@/components/Pagination";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface Approval {
  id: string;
  type: string;
  name: string;
  date: string;
  time: string;
}

interface PaginatedApprovalsProps {
  approvals: Approval[];
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
}

export function PaginatedApprovals({
  approvals,
  onApprove,
  onReject,
}: PaginatedApprovalsProps) {
  const {
    paginatedData,
    currentPage,
    totalPages,
    hasNextPage,
    hasPreviousPage,
    goToNextPage,
    goToPreviousPage,
  } = usePagination(approvals, { pageSize: 5 }); // Show 5 approvals per page

  if (approvals.length === 0) {
    return (
      <div className="text-center py-6">
        <p className="text-gray-500 text-sm">No pending approvals</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Approvals list */}
      <div className="space-y-2">
        {paginatedData.map((approval) => (
          <div
            key={approval.id}
            className="p-3 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Avatar className="w-8 h-8 flex-shrink-0">
                  <AvatarFallback className="text-xs">
                    {approval.name.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="font-medium text-sm truncate">
                      {approval.name}
                    </h4>
                    <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                      {approval.type}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {approval.date} at {approval.time}
                  </p>
                </div>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                {onApprove && (
                  <Button
                    size="sm"
                    variant="default"
                    className="bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1"
                    onClick={() => onApprove(approval.id)}
                  >
                    Approve
                  </Button>
                )}
                {onReject && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-red-600 border-red-600 hover:bg-red-50 text-xs px-3 py-1"
                    onClick={() => onReject(approval.id)}
                  >
                    Reject
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Compact pagination for smaller space */}
      <CompactPagination
        currentPage={currentPage}
        totalPages={totalPages}
        hasNextPage={hasNextPage}
        hasPreviousPage={hasPreviousPage}
        onNextPage={goToNextPage}
        onPreviousPage={goToPreviousPage}
      />
    </div>
  );
}
