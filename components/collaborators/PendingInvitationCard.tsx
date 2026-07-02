"use client";

/**
 * A pending collaboration invitation with Accept / Decline actions.
 * Extracted verbatim from InvitationsPanel.tsx — the mutation lives in
 * the panel and is passed down so the invalidation/toast flow is
 * unchanged. Requires an ancestor <TooltipProvider>.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, Check, X } from "lucide-react";
import { formatCurrencyFromMajorUnit } from "@/utils/formatting";
import type { CollaborationWithPlan } from "./types";
import { ROLE_DESCRIPTIONS, formatRole } from "./format";

export function PendingInvitationCard({
  collab,
  onRespond,
  isResponding,
}: {
  collab: CollaborationWithPlan;
  onRespond: (args: {
    id: string;
    planType: "webinar" | "class";
    response: "ACCEPTED" | "DECLINED";
  }) => void;
  isResponding: boolean;
}) {
  return (
    <Card className="p-4 border-amber-200 bg-amber-50">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-medium text-zinc-800">{collab.planTitle}</p>
          <p className="text-sm text-zinc-600 mt-0.5">
            Invited by{" "}
            <span className="font-medium">
              {collab.invitedBy.user.name ?? "Unknown"}
            </span>
          </p>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="secondary" className="text-xs">
              {collab.planType === "webinar" ? "Webinar" : "Class"}
            </Badge>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="text-xs cursor-help">
                  {formatRole(collab.role)}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  {ROLE_DESCRIPTIONS[collab.role] ?? formatRole(collab.role)}
                </p>
              </TooltipContent>
            </Tooltip>
            <span className="text-xs text-zinc-500">
              {collab.revenueShareBps / 100}% revenue share
            </span>
            {collab.planPrice > 0 && (
              <span className="text-xs text-zinc-500">
                &middot; Plan price{" "}
                {formatCurrencyFromMajorUnit(collab.planPrice, "INR")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-700">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>
              You won&apos;t earn from purchases made before you accept the
              collaborations request.
            </span>
          </div>
        </div>
        <div className="flex gap-2 ml-4">
          <Button
            size="sm"
            variant="default"
            onClick={() =>
              onRespond({
                id: collab.id,
                planType: collab.planType,
                response: "ACCEPTED",
              })
            }
            disabled={isResponding}
          >
            <Check className="w-3.5 h-3.5 mr-1" />
            Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onRespond({
                id: collab.id,
                planType: collab.planType,
                response: "DECLINED",
              })
            }
            disabled={isResponding}
          >
            <X className="w-3.5 h-3.5 mr-1" />
            Decline
          </Button>
        </div>
      </div>
    </Card>
  );
}
