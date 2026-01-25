"use client";

import { cn } from "@/lib/utils";
import { Clock, AlertCircle, XCircle, Shield, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import type { VerificationStatus } from "./VerificationStatusBadge";

interface VerificationPendingOverlayProps {
  status: VerificationStatus;
  rejectionReason?: string;
  resubmitUrl?: string;
  className?: string;
}

const statusContent: Record<
  Exclude<VerificationStatus, "VERIFIED">,
  {
    icon: typeof Clock;
    title: string;
    description: string;
    iconBg: string;
    iconColor: string;
  }
> = {
  PENDING_VERIFICATION: {
    icon: Clock,
    title: "Awaiting Verification",
    description:
      "Your profile is pending verification by our team. This usually takes 1-2 business days. You'll receive an email once your profile is approved.",
    iconBg: "bg-amber-100",
    iconColor: "text-amber-600",
  },
  UNDER_REVIEW: {
    icon: Shield,
    title: "Verification Under Review",
    description:
      "Our team is currently reviewing your profile. This usually takes 1-2 business days. You'll receive an email once the review is complete.",
    iconBg: "bg-blue-100",
    iconColor: "text-blue-600",
  },
  REJECTED: {
    icon: XCircle,
    title: "Verification Not Approved",
    description:
      "Unfortunately, your verification was not approved. Please review the feedback below and update your profile.",
    iconBg: "bg-red-100",
    iconColor: "text-red-600",
  },
};

export function VerificationPendingOverlay({
  status,
  rejectionReason,
  resubmitUrl = "/settings/verification",
  className,
}: VerificationPendingOverlayProps) {
  // Don't show overlay for verified consultants
  if (status === "VERIFIED") {
    return null;
  }

  const content = statusContent[status];
  const Icon = content.icon;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-white/95 backdrop-blur-sm",
        className
      )}
    >
      <div className="max-w-md mx-auto p-8 text-center">
        <div
          className={cn(
            "w-16 h-16 mx-auto mb-6 rounded-full flex items-center justify-center",
            content.iconBg
          )}
        >
          <Icon className={cn("w-8 h-8", content.iconColor)} />
        </div>

        <h2 className="text-2xl font-bold text-zinc-900 mb-3">
          {content.title}
        </h2>

        <p className="text-zinc-600 mb-6">{content.description}</p>

        {status === "REJECTED" && rejectionReason && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-left">
            <p className="text-sm font-medium text-red-800 mb-1">
              Reason for rejection:
            </p>
            <p className="text-sm text-red-700">{rejectionReason}</p>
          </div>
        )}

        {(status === "PENDING_VERIFICATION" || status === "UNDER_REVIEW") && (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-2 text-sm text-zinc-500">
              <AlertCircle className="w-4 h-4" />
              <span>You&apos;ll receive an email once the review is complete</span>
            </div>
            <Button asChild className="gap-2">
              <Link href={resubmitUrl}>
                View Settings
                <ArrowRight className="w-4 h-4" />
              </Link>
            </Button>
          </div>
        )}

        {status === "REJECTED" && (
          <Button asChild className="gap-2">
            <Link href={resubmitUrl}>
              Update Profile
              <ArrowRight className="w-4 h-4" />
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

// Card variant for embedding in pages
export function VerificationPendingCard({
  status,
  rejectionReason,
  resubmitUrl = "/settings/verification",
  className,
}: VerificationPendingOverlayProps) {
  if (status === "VERIFIED") {
    return null;
  }

  const content = statusContent[status];
  const Icon = content.icon;

  return (
    <div
      className={cn(
        "rounded-xl border-2 border-dashed p-6",
        status === "PENDING_VERIFICATION" && "border-amber-300 bg-amber-50",
        status === "UNDER_REVIEW" && "border-blue-300 bg-blue-50",
        status === "REJECTED" && "border-red-300 bg-red-50",
        className
      )}
    >
      <div className="flex items-start gap-4">
        <div
          className={cn(
            "flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center",
            content.iconBg
          )}
        >
          <Icon className={cn("w-6 h-6", content.iconColor)} />
        </div>

        <div className="flex-1">
          <h3 className="font-semibold text-zinc-900 mb-1">{content.title}</h3>
          <p className="text-sm text-zinc-600 mb-3">{content.description}</p>

          {status === "REJECTED" && rejectionReason && (
            <div className="bg-red-100 border border-red-200 rounded-lg p-3 mb-3 text-left">
              <p className="text-xs font-medium text-red-800 mb-0.5">
                Reason:
              </p>
              <p className="text-sm text-red-700">{rejectionReason}</p>
            </div>
          )}

          {status === "REJECTED" && (
            <Button asChild size="sm" className="gap-1.5">
              <Link href={resubmitUrl}>
                Update Profile
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
