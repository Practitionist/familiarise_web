"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  ConsultantVerificationStatus,
  ProfileVerificationStatus,
} from "@prisma/client";

export interface VerificationDocumentFeedback {
  documentId: string;
  fileName: string;
  originalName?: string;
  isValid: boolean | null;
  staffFeedback?: string | null;
}

export interface VerificationStatusData {
  profileId: string;
  isVerified: boolean;
  verificationStatus: ConsultantVerificationStatus;
  linkedinUrl: string | null;
  latestRequest: {
    id: string;
    status: ProfileVerificationStatus;
    submittedAt: string | null;
    reviewedAt: string | null;
    reviewNotes: string | null;
    rejectionReason: string | null;
    feedbackDetails: string | null;
    notes: string | null;
    /** Mapped to the VerificationPendingOverlay's documentFeedback shape. */
    documentFeedback: VerificationDocumentFeedback[];
  } | null;
}

async function fetchVerificationStatus(): Promise<VerificationStatusData> {
  const res = await fetch("/api/verification/status");
  if (!res.ok) throw new Error("Failed to fetch verification status");
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error ?? "Failed to fetch verification status");
  }
  const data = json.data;
  return {
    ...data,
    latestRequest: data.latestRequest
      ? {
          ...data.latestRequest,
          documentFeedback: (data.latestRequest.documents ?? []).map(
            (d: {
              id: string;
              fileName: string;
              originalName?: string;
              isValid: boolean | null;
              staffFeedback?: string | null;
            }) => ({
              documentId: d.id,
              fileName: d.fileName,
              originalName: d.originalName,
              isValid: d.isValid,
              staffFeedback: d.staffFeedback,
            }),
          ),
        }
      : null,
  };
}

/**
 * Latest verification submission for the signed-in consultant, including
 * the reviewer feedback (`rejectionReason` / `feedbackDetails` / per-document
 * `staffFeedback`) from `GET /api/verification/status`.
 *
 * The layout threads this into the REJECTED gate so consultants finally see
 * WHY they were rejected (the overlay always supported the props; nothing
 * fetched them). The Settings verification section consumes the same query,
 * so the two surfaces can never disagree again.
 */
export function useVerificationStatus(enabled = true) {
  return useQuery({
    queryKey: ["verification-status"],
    queryFn: fetchVerificationStatus,
    enabled,
    staleTime: 60_000,
    retry: 2,
  });
}
