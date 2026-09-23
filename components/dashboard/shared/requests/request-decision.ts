/**
 * The consultant's two answers to a request — approve its requested times,
 * or decline it — as ONE mutation each, shared by the Requests tab and the
 * appointment detail page's needs-you slot (#1675). The tab keeps its own
 * dialogs and list bookkeeping; what lives here is the call and the guards
 * that must not drift between the two surfaces.
 */

import type { MutableRefObject } from "react";
import { AppointmentsType } from "@prisma/client";
import {
  AllocationService,
  type AllocationResponse,
} from "@/lib/scheduling/allocationService";
import {
  computeAttemptFingerprint,
  fingerprintGuards,
  resolveAttemptKey,
  type AllocationAttemptKey,
} from "@/hooks/scheduling/useScheduling";

export interface DecidableRequest {
  id: string;
  type: AppointmentsType;
  /** Live tentative slot rows on the request — the stale-tab precondition. */
  tentativeSlotCount?: number;
}

/**
 * The stale-tab guard pair for a requested-times approval, shared verbatim
 * by the idempotency fingerprint and the request body: if the two disagree,
 * a retry after a guard change would replay under the old key (#1012).
 */
export function requestedAllocationGuards(
  request: Pick<DecidableRequest, "tentativeSlotCount">,
): {
  initialAllocation: true | undefined;
  expectedTentativeSlotCount: number | undefined;
} {
  const tentative = request.tentativeSlotCount ?? 0;
  return {
    initialAllocation: tentative === 0 || undefined,
    expectedTentativeSlotCount: tentative > 0 ? tentative : undefined,
  };
}

/**
 * How a 409 from a requested-times approval should be handled: the row is
 * gone (someone allocated it), the snapshot is stale (resync), or the request
 * is still allocatable (keep the dialog open with the server's reason).
 */
export function classifyRequestedConflict(result: {
  success: boolean;
  httpStatus?: number;
  error?: string;
  errorCode?: string;
}): "genuine-conflict" | "stale" | "stay-open" | null {
  if (result.success || result.httpStatus !== 409) return null;
  switch (result.errorCode) {
    case "ALREADY_ALLOCATED":
      return "genuine-conflict";
    case "RESCHEDULE_STATE_CHANGED":
      return "stale";
    default:
      // Co-host clash, illegal transition, slot taken, lock busy, or a code
      // this switch does not know: the request is still allocatable.
      return "stay-open";
  }
}

/** Approve by confirming the times the consultee asked for. */
export async function approveRequestedTimes(
  request: DecidableRequest,
  attemptKeyRef: MutableRefObject<AllocationAttemptKey | null>,
  override: boolean,
): Promise<AllocationResponse> {
  const eventType =
    request.type === AppointmentsType.SUBSCRIPTION
      ? "subscription"
      : "consultation";
  // A guard change mints a fresh key so the server enforces it instead of
  // replaying the earlier batch (#1012).
  const guards = requestedAllocationGuards(request);
  const attempt = resolveAttemptKey(
    attemptKeyRef.current,
    computeAttemptFingerprint(
      "requested",
      request.id,
      [],
      undefined,
      fingerprintGuards(guards),
    ),
  );
  attemptKeyRef.current = attempt;
  // Via the shared client so a non-JSON edge error still carries its HTTP
  // status (fail-closed) and structured codes survive to the caller.
  return AllocationService.allocateSlots(eventType, request.id, [], {
    useRequestedSlots: true,
    override,
    ...guards,
    idempotencyKey: attempt.key,
  });
}

/** A refused decision, with the HTTP status and code the surface routes on (#1705). */
export class DecisionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

/** Decline: rejects the whole request (and refunds anything paid). Throws on a refusal. */
export async function declineRequest(
  request: Pick<DecidableRequest, "id" | "type">,
): Promise<void> {
  const endpoint =
    request.type === AppointmentsType.SUBSCRIPTION
      ? `/api/bookings/subscriptions/${request.id}`
      : `/api/bookings/consultations/${request.id}`;
  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "REJECTED" }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  if (!response.ok) {
    throw new DecisionError(
      data.error || "Failed to decline request",
      response.status,
      data.code,
    );
  }
}
