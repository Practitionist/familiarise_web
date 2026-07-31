import * as Sentry from "@sentry/nextjs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { toast } from "@/components/ui/use-toast";
import { AppointmentsType, AppointmentStatus } from "@prisma/client";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { RequestedSlotsDialog } from "./components/RequestedSlotsDialog";
import { PaymentRequiredBadge } from "./components/PaymentRequiredBadge";
import { SafeUnifiedCalendar } from "@/components/scheduling/SafeUnifiedCalendar";
import {
  ConsultationApiResponse,
  RequestedBy,
  SubscriptionApiResponse,
} from "./types";
import { countSundayWeeksInclusive } from "@/lib/scheduling/calendarUtils";
import {
  allocatedElsewhere,
  allocationFailed,
  planConfigIncomplete,
} from "@/lib/scheduling/allocationMessages";
import {
  computeAttemptFingerprint,
  resolveAttemptKey,
  type AllocationAttemptKey,
} from "@/hooks/scheduling/useSlotAllocation";

// Slot with tentative status for reschedule visibility
interface RequestedSlot {
  startsAt: string;
  isTentative: boolean;
}

interface Request {
  id: string;
  type: AppointmentsType;
  title: string;
  requestedBy: RequestedBy;
  requestedAt: string;
  requestedTimes?: string[]; // Kept for backward compatibility
  requestedSlots?: RequestedSlot[]; // New: includes isTentative flag
  status: AppointmentStatus;
  /** undefined = plan data is incomplete (no totalSessions AND no scheduling
   * period) — the server would reject any allocation, so actions are disabled. */
  requiredSlots?: number;
  allocatedSlots?: string[];
  durationInMonths?: number;
  sessionsPerWeek?: number;
  sessionDurationInHours?: number;
  durationInHours?: number;
  startDate?: Date;
  endDate?: Date;
  /** Limit day/week bucket timezone (ADR B9); Subscription column default. */
  schedulingTimezone?: string;
  bookingSource?: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED"; // Booking source - direct checkout or request submitted
  totalSessions?: number; // Authoritative session count from plan (overrides weeks × sessionsPerWeek)
  // Reschedule info
  tentativeSlotCount?: number;
  totalSlotCount?: number;
  /** Slots released by a reschedule. Their startsAt is still the ORIGINAL time,
   * so "Use Requested Times" would re-confirm what the consultee asked to move. */
  rescheduledSlotCount?: number;
}

// interface SlotInterval { ... } // Removed - Now imported

type RequestType = "all" | "consultation" | "subscription";

interface RequestSlotAllocationTabProps {
  type: RequestType;
  onUpdate: () => void;
  /**
   * Whose requests to allocate. Falls back to the `[consultantId]` route param
   * so the consultant tree keeps working untouched; the org tree has no such
   * param and passes it explicitly.
   */
  consultantProfileId?: string;
  /**
   * Funding context, forwarded as `?orgScope=`.
   *
   * `/api/bookings/{consultations,subscriptions}` EXCLUDE org-funded rows when
   * this is absent, so omitting it is how org-sponsored requests became
   * invisible: the only allocation surface in the product sat in the consultant
   * tree and silently dropped them, and an org-sponsored subscription was paid
   * for and never scheduled. Personal keeps the B2C-only behaviour; an org id
   * narrows to that organization.
   */
  orgScope?: "personal" | (string & {});
}

// Helper function to fetch and process data
async function fetchDataFromApi<T>(
  url: string,
): Promise<{ ok: boolean; data: T | null; error?: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to fetch ${url}:`, errorText);
      return {
        ok: false,
        data: null,
        // Keep server errors somewhat specific
        error: `Server error (${response.status}) while fetching data.`,
      };
    }
    const data = await response.json();
    // Ensure data exists and has the expected structure
    if (data && data.data !== undefined) {
      return { ok: true, data: data.data as T, error: undefined };
    } else {
      console.error(`Unexpected response structure from ${url}:`, data);
      return {
        ok: false,
        data: null,
        error: "Received unexpected data structure from server.",
      };
    }
  } catch (err) {
    let message = "An unknown error occurred while fetching data.";
    // Specifically check for the browser's network error
    if (err instanceof TypeError && err.message === "Failed to fetch") {
      // Use warn (not error) — this is a transient network hiccup, not a code bug
      console.warn(
        `Network error fetching ${url}: server temporarily unreachable`,
      );
      message =
        "Network error: Could not connect to the server. Please check your internet connection.";
    } else if (err instanceof Error) {
      console.error(`Error fetching ${url}:`, err);
      message = err.message;
    }
    return { ok: false, data: null, error: message };
  }
}

export function RequestSlotAllocationTab({
  type,
  onUpdate,
  consultantProfileId,
  orgScope = "personal",
}: RequestSlotAllocationTabProps) {
  const params = useParams();
  const consultantId =
    consultantProfileId ?? (params.consultantId as string);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<Request[]>([]);
  const [selectedRequest, setSelectedRequest] = useState<Request | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [requestedSlotsDialogOpen, setRequestedSlotsDialogOpen] =
    useState(false);
  const [selectedRequestForDialog, setSelectedRequestForDialog] =
    useState<Request | null>(null);

  // Fetch requests, available slots, and existing appointments
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch data in parallel (only PENDING requests).
      const [consultationsResult, subscriptionsResult] = await Promise.all([
        fetchDataFromApi<ConsultationApiResponse[]>(
          `/api/bookings/consultations?consultantProfileId=${consultantId}&status=PENDING&orgScope=${orgScope}`,
        ),
        fetchDataFromApi<SubscriptionApiResponse[]>(
          `/api/bookings/subscriptions?consultantProfileId=${consultantId}&status=PENDING&orgScope=${orgScope}`,
        ),
      ]);

      // Check results for the first error
      const results = [consultationsResult, subscriptionsResult];

      for (const result of results) {
        if (!result.ok && result.error) {
          // Set the first encountered error and stop
          setError(result.error);
          setLoading(false); // Ensure loading state is updated
          return; // Exit fetchData early
        }
      }

      // If we reach here, all fetches were successful (or returned data: null without error)

      // --- Process Data (only if all fetches were ok) ---
      const processedRequests: Request[] = [];

      // Process consultations
      if (
        consultationsResult.ok &&
        consultationsResult.data &&
        (type === "all" || type === "consultation")
      ) {
        processedRequests.push(
          ...consultationsResult.data.map((consultation) => {
            const slots = consultation.appointment?.slotsOfAppointment || [];
            const tentativeCount = slots.filter((s) => s.isTentative).length;
            const rescheduledCount = slots.filter(
              (s) => s.completionStatus === "RESCHEDULED",
            ).length;
            const totalCount = slots.length;

            return {
              id: consultation.id,
              type: AppointmentsType.CONSULTATION,
              title: consultation.consultationPlan?.title || "Untitled Plan",
              requestedBy: consultation.requestedBy,
              requestedAt: consultation.requestedAt,
              requestedTimes: slots.map((slot) => slot.startsAt),
              requestedSlots: slots.map((slot) => ({
                startsAt: slot.startsAt,
                isTentative: slot.isTentative ?? false,
              })),
              status: consultation.status,
              requiredSlots: Math.ceil(
                (consultation.consultationPlan?.durationInHours || 1) / 0.5,
              ), // Convert hours to 30-min slots
              durationInHours:
                consultation.consultationPlan?.durationInHours || 1,
              bookingSource: consultation.bookingSource,
              tentativeSlotCount: tentativeCount,
              rescheduledSlotCount: rescheduledCount,
              totalSlotCount: totalCount,
            };
          }),
        );
      }

      // Process subscriptions
      if (
        subscriptionsResult.ok &&
        subscriptionsResult.data &&
        (type === "all" || type === "subscription")
      ) {
        processedRequests.push(
          ...subscriptionsResult.data.map((subscription) => {
            const sessionDuration =
              subscription.subscriptionPlan?.sessionDurationInHours || 1;
            const slotsPerSession = Math.ceil(sessionDuration / 0.5);

            // Flatten all slots from all appointments
            const allSlots =
              subscription.appointments?.flatMap(
                (appt) => appt.slotsOfAppointment || [],
              ) || [];
            const tentativeCount = allSlots.filter((s) => s.isTentative).length;
            const rescheduledCount = allSlots.filter(
              (s) => s.completionStatus === "RESCHEDULED",
            ).length;
            const totalCount = allSlots.length;

            return {
              id: subscription.id,
              type: AppointmentsType.SUBSCRIPTION,
              title: subscription.subscriptionPlan?.title || "Untitled Plan",
              requestedBy: subscription.requestedBy,
              requestedAt: subscription.requestedAt,
              requestedTimes: allSlots.map((slot) => slot.startsAt),
              requestedSlots: allSlots.map((slot) => ({
                startsAt: slot.startsAt,
                isTentative: slot.isTentative ?? false,
              })),
              status: subscription.status,
              // When rescheduling (tentative slots exist), only require replacing those slots
              requiredSlots:
                tentativeCount > 0
                  ? tentativeCount
                  : (() => {
                      const totalSessions =
                        subscription.subscriptionPlan?.totalSessions;
                      if (totalSessions && totalSessions > 0) {
                        return totalSessions * slotsPerSession;
                      }
                      // Fallback: week-based calculation
                      const startDate = subscription.schedulingPeriodStartsAt
                        ? new Date(subscription.schedulingPeriodStartsAt)
                        : undefined;
                      const endDate = subscription.schedulingPeriodEndsAt
                        ? new Date(subscription.schedulingPeriodEndsAt)
                        : undefined;
                      const sessionsPerWeek =
                        subscription.subscriptionPlan?.sessionsPerWeek ?? 0;
                      if (startDate && endDate) {
                        const weeks = countSundayWeeksInclusive(
                          startDate,
                          endDate,
                        );
                        return weeks * sessionsPerWeek * slotsPerSession;
                      }
                      // No totalSessions AND no period: the server throws for
                      // such subscriptions, so any client guess (the old
                      // sessionsPerWeek×4×months) produced an allocation the
                      // server rejected. Surface a degraded state instead.
                      Sentry.captureMessage(
                        "Subscription plan missing totalSessions and scheduling period",
                        {
                          tags: {
                            subsystem: "client",
                            feature: "slot-allocation",
                          },
                          extra: { subscriptionId: subscription.id },
                        },
                      );
                      return undefined;
                    })(),
              totalSessions:
                tentativeCount > 0
                  ? tentativeCount / slotsPerSession
                  : subscription.subscriptionPlan?.totalSessions,
              durationInMonths: subscription.subscriptionPlan?.durationInMonths,
              sessionsPerWeek: subscription.subscriptionPlan?.sessionsPerWeek,
              sessionDurationInHours: sessionDuration,
              // Scheduling period for subscriptions (using correct field names from Prisma schema)
              startDate: subscription.schedulingPeriodStartsAt
                ? new Date(subscription.schedulingPeriodStartsAt)
                : undefined,
              endDate: subscription.schedulingPeriodEndsAt
                ? new Date(subscription.schedulingPeriodEndsAt)
                : undefined,
              schedulingTimezone: subscription.schedulingTimezone,
              bookingSource: subscription.bookingSource,
              tentativeSlotCount: tentativeCount,
              rescheduledSlotCount: rescheduledCount,
              totalSlotCount: totalCount,
            };
          }),
        );
      }

      // --- Update State ---
      setRequests(processedRequests);
    } catch (err) {
      // This catch block now primarily handles errors during data *processing*
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "client" } });
      console.error("Error processing fetched data:", err);
      setError(
        err instanceof Error
          ? err.message
          : "An unexpected error occurred while processing data.",
      );
    } finally {
      // setLoading(false) is handled earlier in case of fetch errors
      // Only set it here if no fetch error occurred
      if (!error) {
        setLoading(false);
      }
    }
    // orgScope belongs here: fetchData builds both URLs from it, so without it
    // a scope change without a remount keeps refetching the previous org's rows.
  }, [consultantId, type, error, orgScope]);

  useEffect(() => {
    fetchData();
    // Set up polling for real-time updates
    const REQUEST_POLL_INTERVAL = parseInt(
      process.env.NEXT_PUBLIC_REQUEST_POLL_INTERVAL ?? "300000",
    ); // 5 minutes
    // Perf RCA: skip the tick while the tab is hidden — the old interval
    // kept hitting the API from backgrounded tabs.
    const interval = setInterval(() => {
      if (!document.hidden) fetchData();
    }, REQUEST_POLL_INTERVAL);

    // Multi-tab self-heal: a tab returning to focus refetches so requests
    // allocated/declined elsewhere disappear without waiting for the poll.
    const onFocus = () => fetchData();
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchData]);

  // Idempotency key for the requested-times flow; a retry of the same request
  // reuses the key so the server replays instead of double-booking (#837).
  // A ref, not state — two clicks before a rerender must see the same key.
  const attemptKeyRef = useRef<AllocationAttemptKey | null>(null);

  /** Shared 409 handling: another session already allocated this request. */
  const handleConflict = useCallback(
    (requestId?: string) => {
      toast(allocatedElsewhere());
      setDialogOpen(false);
      setSelectedRequest(null);
      setRequestedSlotsDialogOpen(false);
      setSelectedRequestForDialog(null);
      if (requestId) {
        setRequests((prev) => prev.filter((r) => r.id !== requestId));
      }
      fetchData();
      onUpdate();
    },
    [fetchData, onUpdate],
  );

  const handleRequestedAllocation = async (override: boolean) => {
    if (!selectedRequestForDialog) return;

    try {
      const endpoint =
        selectedRequestForDialog.type === AppointmentsType.SUBSCRIPTION
          ? `/api/bookings/subscriptions/${selectedRequestForDialog.id}/allocate`
          : `/api/bookings/consultations/${selectedRequestForDialog.id}/allocate`;

      const attempt = resolveAttemptKey(
        attemptKeyRef.current,
        computeAttemptFingerprint(
          "requested",
          selectedRequestForDialog.id,
          [],
        ),
      );
      attemptKeyRef.current = attempt;

      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.key,
        },
        body: JSON.stringify({
          isAuto: false,
          useRequestedSlots: true,
          override,
          // Fresh allocations only — partial reschedules legitimately have
          // confirmed slots and must not trip the already-allocated guard.
          initialAllocation:
            (selectedRequestForDialog.tentativeSlotCount ?? 0) === 0 ||
            undefined,
        }),
      });

      const data = await response.json();

      if (response.status === 409) {
        handleConflict(selectedRequestForDialog.id);
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || "Failed to allocate slots");
      }

      // Success handling
      toast({
        title: "Times confirmed",
        description: "Your requested times have been scheduled.",
        variant: "default",
      });

      // Close dialog and reset state
      setRequestedSlotsDialogOpen(false);
      setSelectedRequestForDialog(null);

      // Remove request from list
      setRequests((prev) =>
        prev.filter((r) => r.id !== selectedRequestForDialog.id),
      );

      // Notify parent
      onUpdate();
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client", feature: "slot-allocation" } });
      toast(
        allocationFailed(
          error instanceof Error ? error.message : "Failed to allocate slots",
        ),
      );
    }
  };

  const handleDecline = async (request: Request) => {
    if (request.type !== AppointmentsType.CONSULTATION) return;
    try {
      const response = await fetch(`/api/bookings/consultations/${request.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "REJECTED" }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to decline request");
      }
      toast({
        title: "Request declined",
        description: "The consultation request has been declined.",
        variant: "default",
      });
      setRequests((prev) => prev.filter((r) => r.id !== request.id));
      onUpdate();
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to decline request",
        variant: "destructive",
      });
    }
  };

  // Handle allocation complete from UnifiedCalendar
  const handleAllocationComplete = async () => {
    toast({
      title: "Schedule confirmed",
      description: "All session times have been scheduled.",
      variant: "default",
    });

    // Close dialog and reset state
    setDialogOpen(false);
    setSelectedRequest(null);

    // Remove request from list
    setRequests((prev) => prev.filter((r) => r.id !== selectedRequest?.id));

    // Notify parent
    onUpdate();
  };

  if (loading) {
    return (
      <Card className="border-0 shadow-none rounded-none">
        <CardHeader>
          <CardTitle className="text-xl font-bold">Requests</CardTitle>
          <CardDescription>
            Loading requests and availability...
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center p-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-0 shadow-none rounded-none">
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => window.location.reload()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const columns: ResponsiveColumn<Request>[] = [
    {
      key: "type",
      header: "Type",
      headClassName: "w-[110px]",
      cell: (request) => getRequestTypeLabel(request.type),
    },
    {
      key: "title",
      header: "Title",
      primary: true,
      headClassName: "w-[150px]",
      cell: (request) => request.title,
    },
    {
      key: "requestedBy",
      header: "Requested By",
      headClassName: "w-[130px]",
      cell: (request) => request.requestedBy.user.name,
    },
    {
      key: "requestedAt",
      header: "Requested At",
      headClassName: "w-[130px]",
      cell: (request) =>
        new Date(request.requestedAt).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
    },
    {
      key: "requestedTimes",
      header: "Requested Times",
      cell: (request) => (
        <>
          {/* Reschedule indicator */}
          {request.tentativeSlotCount !== undefined &&
            request.tentativeSlotCount > 0 &&
            request.totalSlotCount !== undefined && (
              <div className="mb-2">
                {request.tentativeSlotCount === request.totalSlotCount ? (
                  <div className="flex items-center gap-1.5 text-xs font-medium text-foreground bg-secondary px-2 py-1 rounded-md">
                    <RefreshCw className="h-3 w-3" />
                    Full Reschedule (all {request.totalSlotCount} session
                    {request.totalSlotCount !== 1 ? "s" : ""})
                  </div>
                ) : request.tentativeSlotCount === 1 ? (
                  <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded-md">
                    <AlertTriangle className="h-3 w-3" />
                    Individual Session (1 of {request.totalSlotCount} needs new
                    time)
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded-md">
                    <AlertTriangle className="h-3 w-3" />
                    Multiple Sessions ({request.tentativeSlotCount} of{" "}
                    {request.totalSlotCount} need new times)
                  </div>
                )}
              </div>
            )}

          {request.requestedSlots && request.requestedSlots.length > 0 ? (
            <div className="space-y-1">
              {request.requestedSlots.slice(0, 5).map((slot, index) => {
                const date = new Date(slot.startsAt);
                const isValidDate = !isNaN(date.getTime());

                return (
                  <div
                    key={`${request.id}-slot-${index}`}
                    className={`flex items-center gap-1.5 text-sm ${
                      slot.isTentative
                        ? "text-amber-600"
                        : "text-muted-foreground"
                    }`}
                  >
                    {slot.isTentative ? (
                      <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 flex-shrink-0 text-green-500" />
                    )}
                    <span>
                      {isValidDate
                        ? date.toLocaleString(undefined, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })
                        : "Invalid date"}
                    </span>
                    {slot.isTentative && (
                      <span className="text-xs text-amber-500">
                        (needs rescheduling)
                      </span>
                    )}
                  </div>
                );
              })}
              {request.requestedSlots.length > 5 && (
                <div className="text-xs text-muted-foreground pl-5">
                  ... and {request.requestedSlots.length - 5} more slot
                  {request.requestedSlots.length - 5 !== 1 ? "s" : ""}
                </div>
              )}
            </div>
          ) : request.requestedTimes && request.requestedTimes.length > 0 ? (
            // Fallback to old format if requestedSlots not available
            <div className="space-y-1">
              {request.requestedTimes.slice(0, 5).map((time, index) => {
                const date = new Date(time);
                const isValidDate = !isNaN(date.getTime());

                return (
                  <div key={`${request.id}-time-${index}`} className="text-sm">
                    {isValidDate
                      ? date.toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : "Invalid date"}
                  </div>
                );
              })}
              {request.requestedTimes.length > 5 && (
                <div className="text-xs text-muted-foreground">
                  ... and {request.requestedTimes.length - 5} more slot
                  {request.requestedTimes.length - 5 !== 1 ? "s" : ""}
                </div>
              )}
            </div>
          ) : request.type === AppointmentsType.SUBSCRIPTION &&
            request.startDate &&
            request.endDate ? (
            <div className="text-sm">
              <div className="font-medium text-foreground">
                Scheduling Period
              </div>
              <div className="text-xs text-muted-foreground">
                {request.startDate.toLocaleDateString()} -{" "}
                {request.endDate.toLocaleDateString()}
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Not available</div>
          )}
        </>
      ),
    },
    {
      key: "requiredSlots",
      header: "Required Slots",
      headClassName: "w-[90px] text-center",
      className: "text-center",
      cell: (request) => request.requiredSlots ?? "—",
    },
    {
      key: "status",
      header: "Status",
      headClassName: "w-[120px]",
      cell: (request) => (
        <div className="flex flex-col gap-1">
          <Badge variant={getRequestStatusBadgeVariant(request.status)}>
            {getRequestStatusLabel(request.status)}
          </Badge>
          {request.status === AppointmentStatus.APPROVED_PENDING_PAYMENT && (
            <PaymentRequiredBadge variant="full" />
          )}
        </div>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      headClassName: "w-[150px]",
      cell: (request) =>
        request.status === AppointmentStatus.PENDING ? (
          <div className="flex flex-col gap-1.5">
            {request.requiredSlots === undefined ? (
              <p className="text-xs text-muted-foreground">
                {planConfigIncomplete().description}
              </p>
            ) : (
              <>
                {/* Hidden for directly booked consultations (Bug #8 fix), and
                    for anything awaiting reschedule: those slots still carry
                    the ORIGINAL startsAt, so "using" them would re-confirm the
                    times the consultee just asked to move. */}
                {request.requestedTimes &&
                  request.requestedTimes.length > 0 &&
                  request.bookingSource === "REQUEST_SUBMITTED" &&
                  (request.rescheduledSlotCount ?? 0) === 0 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full"
                      onClick={() => {
                        setSelectedRequestForDialog(request);
                        setRequestedSlotsDialogOpen(true);
                      }}
                    >
                      Use Requested Times
                    </Button>
                  )}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    setSelectedRequest(request);
                    setDialogOpen(true);
                  }}
                >
                  Allocate Slots
                </Button>
              </>
            )}
            {request.type === AppointmentsType.CONSULTATION && (
              <Button
                variant="destructive"
                size="sm"
                className="w-full"
                onClick={() => handleDecline(request)}
              >
                Decline
              </Button>
            )}
          </div>
        ) : null,
    },
  ];

  return (
    <Card className="border-0 shadow-none rounded-none">
      <CardHeader>
        <CardTitle className="text-fluid-xl font-semibold tracking-tight">
          Requests
        </CardTitle>
        <CardDescription>
          Review and allocate slots for incoming session requests
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0 sm:p-6">
        {requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
              <AlertTriangle className="h-8 w-8 text-muted-foreground/70" />
            </div>
            <h4 className="text-lg font-semibold text-foreground">
              No pending requests
            </h4>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">
              When consultees request sessions through your profile, they will
              appear here for slot allocation.
            </p>
          </div>
        ) : (
          <ResponsiveTable<Request>
            columns={columns}
            rows={requests}
            getRowId={(r) => r.id}
          />
        )}

        {/* Single Allocation Dialog - moved outside map loop to prevent multiple dialogs */}
        <ResponsiveModal open={dialogOpen} onOpenChange={setDialogOpen}>
          <ResponsiveModalContent className="max-w-[95vw] w-full lg:max-w-[1400px] max-h-[90dvh] overflow-hidden flex flex-col">
            <ResponsiveModalHeader className="shrink-0">
              <ResponsiveModalTitle>Allocate Slots</ResponsiveModalTitle>
              <ResponsiveModalDescription asChild>
                {selectedRequest && (
                  <div className="space-y-1 text-sm text-muted-foreground">
                    <p>
                      Choose {selectedRequest.requiredSlots} slots for{" "}
                      {selectedRequest.type.toLowerCase()}
                    </p>
                    {selectedRequest.type === "SUBSCRIPTION" &&
                      selectedRequest.sessionDurationInHours && (
                        <p className="text-xs">
                          Each call is{" "}
                          {selectedRequest.sessionDurationInHours === 1
                            ? "1 hour"
                            : `${selectedRequest.sessionDurationInHours} hours`}{" "}
                          (
                          {Math.ceil(
                            selectedRequest.sessionDurationInHours / 0.5,
                          )}{" "}
                          consecutive slots per call)
                        </p>
                      )}
                    {selectedRequest.type === "CONSULTATION" &&
                      selectedRequest.durationInHours && (
                        <p className="text-xs">
                          Consultation is{" "}
                          {selectedRequest.durationInHours === 1
                            ? "1 hour"
                            : `${selectedRequest.durationInHours} hours`}{" "}
                          ({Math.ceil(selectedRequest.durationInHours / 0.5)}{" "}
                          consecutive slots)
                        </p>
                      )}
                    {selectedRequest.startDate && selectedRequest.endDate && (
                      <p className="text-xs text-muted-foreground">
                        Scheduling period:{" "}
                        {selectedRequest.startDate.toLocaleDateString()} -{" "}
                        {selectedRequest.endDate.toLocaleDateString()}
                      </p>
                    )}
                  </div>
                )}
              </ResponsiveModalDescription>
            </ResponsiveModalHeader>
            {selectedRequest && (
              <SafeUnifiedCalendar
                className="min-h-0 flex-1"
                consultantId={consultantId}
                eventType={
                  selectedRequest.type.toLowerCase() as
                    | "consultation"
                    | "subscription"
                }
                eventId={selectedRequest.id}
                consulteeUserId={selectedRequest.requestedBy?.user?.id}
                mode="allocate"
                onAllocationComplete={handleAllocationComplete}
                onAllocationConflict={() => handleConflict(selectedRequest.id)}
                initialAllocation={
                  (selectedRequest.tentativeSlotCount ?? 0) === 0
                }
                showAllocationButtons={true}
                durationInMonths={
                  selectedRequest.type === "SUBSCRIPTION"
                    ? selectedRequest.durationInMonths
                    : undefined
                }
                durationInHours={
                  selectedRequest.type === "CONSULTATION"
                    ? selectedRequest.durationInHours
                    : undefined
                }
                sessionsPerWeek={
                  selectedRequest.type === "SUBSCRIPTION"
                    ? selectedRequest.sessionsPerWeek
                    : undefined
                }
                sessionDurationInHours={
                  selectedRequest.type === "SUBSCRIPTION"
                    ? selectedRequest.sessionDurationInHours
                    : undefined
                }
                allowedStart={selectedRequest.startDate}
                allowedEnd={selectedRequest.endDate}
                schedulingTimezone={selectedRequest.schedulingTimezone}
                totalSessions={
                  selectedRequest.type === "SUBSCRIPTION"
                    ? selectedRequest.totalSessions
                    : undefined
                }
              />
            )}
          </ResponsiveModalContent>
        </ResponsiveModal>

        <RequestedSlotsDialog
          open={requestedSlotsDialogOpen}
          onOpenChange={setRequestedSlotsDialogOpen}
          requestId={selectedRequestForDialog?.id || ""}
          requestType={
            selectedRequestForDialog?.type || AppointmentsType.CONSULTATION
          }
          requestedSlots={selectedRequestForDialog?.requestedTimes || []}
          requestedSlotsWithStatus={selectedRequestForDialog?.requestedSlots}
          schedulingPeriod={
            selectedRequestForDialog?.startDate &&
            selectedRequestForDialog?.endDate
              ? {
                  startDate: selectedRequestForDialog.startDate,
                  endDate: selectedRequestForDialog.endDate,
                }
              : undefined
          }
          onConfirm={handleRequestedAllocation}
          onCancel={() => {
            setRequestedSlotsDialogOpen(false);
            setSelectedRequestForDialog(null);
          }}
        />
      </CardContent>
    </Card>
  );
}

// Helper function for badge variant
function getRequestStatusBadgeVariant(
  status: AppointmentStatus,
): "outline" | "default" | "destructive" | "secondary" {
  switch (status) {
    case AppointmentStatus.PENDING:
    case AppointmentStatus.APPROVED_PENDING_PAYMENT:
      return "outline";
    case AppointmentStatus.APPROVED:
    case AppointmentStatus.SCHEDULED:
      return "default";
    case AppointmentStatus.COMPLETED:
      return "secondary";
    case AppointmentStatus.REJECTED:
    case AppointmentStatus.CANCELLED:
    case AppointmentStatus.EXPIRED:
      return "destructive";
    default:
      return "outline";
  }
}

function getRequestStatusLabel(status: AppointmentStatus): string {
  switch (status) {
    case AppointmentStatus.PENDING:
      return "Pending";
    case AppointmentStatus.APPROVED:
      return "Approved";
    case AppointmentStatus.APPROVED_PENDING_PAYMENT:
      return "Awaiting Payment";
    case AppointmentStatus.SCHEDULED:
      return "Scheduled";
    case AppointmentStatus.COMPLETED:
      return "Completed";
    case AppointmentStatus.REJECTED:
      return "Rejected";
    case AppointmentStatus.CANCELLED:
      return "Cancelled";
    case AppointmentStatus.EXPIRED:
      return "Expired";
    default:
      return status;
  }
}

function getRequestTypeLabel(type: AppointmentsType): string {
  switch (type) {
    case AppointmentsType.CONSULTATION:
      return "Consultation";
    case AppointmentsType.SUBSCRIPTION:
      return "Subscription";
    case AppointmentsType.WEBINAR:
      return "Webinar";
    case AppointmentsType.CLASS:
      return "Class";
    default:
      return type;
  }
}
