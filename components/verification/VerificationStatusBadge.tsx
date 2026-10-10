"use client";

import { cn } from "@/utils/tailwind";
import { CheckCircle, Clock, XCircle, AlertCircle, Shield } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type VerificationStatus =
  | "PENDING_VERIFICATION"
  | "UNDER_REVIEW"
  | "VERIFIED"
  | "REJECTED";

interface VerificationStatusBadgeProps {
  status: VerificationStatus;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
  className?: string;
}

const statusConfig: Record<
  VerificationStatus,
  {
    icon: typeof CheckCircle;
    label: string;
    description: string;
    colorClass: string;
    bgClass: string;
  }
> = {
  PENDING_VERIFICATION: {
    icon: Clock,
    label: "Pending",
    description: "Awaiting verification submission",
    colorClass: "text-amber-600",
    bgClass: "bg-amber-100",
  },
  UNDER_REVIEW: {
    icon: AlertCircle,
    label: "Under Review",
    description: "Your verification is being reviewed by our team",
    colorClass: "text-blue-600",
    bgClass: "bg-blue-100",
  },
  VERIFIED: {
    icon: CheckCircle,
    label: "Verified",
    description: "Your profile has been verified",
    colorClass: "text-green-600",
    bgClass: "bg-green-100",
  },
  REJECTED: {
    icon: XCircle,
    label: "Rejected",
    description: "Verification was not approved. Please resubmit.",
    colorClass: "text-red-600",
    bgClass: "bg-red-100",
  },
};

const sizeConfig = {
  sm: {
    icon: "w-3.5 h-3.5",
    text: "text-xs",
    padding: "px-2 py-0.5",
  },
  md: {
    icon: "w-4 h-4",
    text: "text-sm",
    padding: "px-2.5 py-1",
  },
  lg: {
    icon: "w-5 h-5",
    text: "text-base",
    padding: "px-3 py-1.5",
  },
};

export function VerificationStatusBadge({
  status,
  size = "md",
  showLabel = true,
  className,
}: VerificationStatusBadgeProps) {
  const config = statusConfig[status];
  const sizes = sizeConfig[size];
  const Icon = config.icon;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full font-medium",
              config.bgClass,
              config.colorClass,
              sizes.padding,
              sizes.text,
              className,
            )}
          >
            <Icon className={sizes.icon} />
            {showLabel && <span>{config.label}</span>}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>{config.description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Compact verified badge for public profiles
export function VerifiedBadge({
  className,
  size = "sm",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const sizes = sizeConfig[size];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn("inline-flex items-center text-blue-600", className)}
          >
            <Shield className={cn(sizes.icon, "fill-current")} />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>Verified Consultant</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
