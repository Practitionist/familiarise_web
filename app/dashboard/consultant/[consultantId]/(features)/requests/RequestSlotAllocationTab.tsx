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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";
import { AppointmentsType, AppointmentStatus } from "@prisma/client";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { RequestedSlotsDialog } from "./components/RequestedSlotsDialog";
import { PaymentRequiredBadge } from "./components/PaymentRequiredBadge";
import { SafeUnifiedCalendar } from "../shared/components/SafeUnifiedCalendar";
import {
  ConsultationApiResponse,
  RequestedBy,
  SubscriptionApiResponse,
} from "./types";
import { countSundayWeeksInclusive } from "../shared/utils/calendarUtils";

// --- API Response Type Definitions ---
// interface UserInfo { ... } // Removed
// interface RequestedBy { ... } // Removed
// interface ConsultationPlanInfo { ... } // Removed
// interface SubscriptionPlanInfo { ... } // Removed
// interface AppointmentSlot { ... } // Removed (part of SlotInterval now)
// interface AppointmentInfo { ... } // Removed
// interface ConsultationApiResponse { ... } // Removed
// interface SubscriptionApiResponse { ... } // Removed
// interface AvailabilityApiResponse extends AppointmentSlot { } // Removed
// interface ConsultantApiResponse { ... } // Removed
// --- End API Response Type Definitions ---

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
  requiredSlots: number;
  allocatedSlots?: string[];
  durationInMonths?: number;
  callsPerWeek?: number;
  sessionDurationInHours?: number;
  durationInHours?: number;
  startDate?: Date;
  endDate?: Date;
  bookingSource?: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED"; // Booking source - direct checkout or request submitted
  totalSessions?: number; // Authoritative session count from plan (overrides weeks × callsPerWeek)
  // Reschedule info
  tentativeSlotCount?: number;
  totalSlotCount?: number;
}

// interface SlotInterval { ... } // Removed - Now imported

type RequestType = "all" | "consultation" | "subscription";

interface RequestSlotAllocationTabProps {
  type: RequestType;
  onUpdate: () => void;
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
}: RequestSlotAllocationTabProps) {
  const params = useParams();
  const consultantId = params.consultantId as string;
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
      // Fetch data in parallel (only PENDING requests)
      const [consultationsResult, subscriptionsResult] = await Promise.all([
        fetchDataFromApi<ConsultationApiResponse[]>(
          `/api/bookings/consultations?consultantProfileId=${consultantId}&status=PENDING`,
        ),
        fetchDataFromApi<SubscriptionApiResponse[]>(
          `/api/bookings/subscriptions?consultantProfileId=${consultantId}&status=PENDING`,
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
                      const callsPerWeek =
                        subscription.subscriptionPlan?.callsPerWeek ?? 0;
                      if (startDate && endDate) {
                        const weeks = countSundayWeeksInclusive(
                          startDate,
                          endDate,
                        );
                        return weeks * callsPerWeek * slotsPerSession;
                      }
                      return (
                        callsPerWeek *
                          4 *
                          (subscription.subscriptionPlan?.durationInMonths ??
                            0) *
                          slotsPerSession || 0
                      );
                    })(),
              totalSessions:
                tentativeCount > 0
                  ? tentativeCount / slotsPerSession
                  : subscription.subscriptionPlan?.totalSessions,
              durationInMonths: subscription.subscriptionPlan?.durationInMonths,
              callsPerWeek: subscription.subscriptionPlan?.callsPerWeek,
              sessionDurationInHours: sessionDuration,
              // Scheduling period for subscriptions (using correct field names from Prisma schema)
              startDate: subscription.schedulingPeriodStartsAt
                ? new Date(subscription.schedulingPeriodStartsAt)
                : undefined,
              endDate: subscription.schedulingPeriodEndsAt
                ? new Date(subscription.schedulingPeriodEndsAt)
                : undefined,
              bookingSource: subscription.bookingSource,
              tentativeSlotCount: tentativeCount,
              totalSlotCount: totalCount,
            };
          }),
        );
      }

      // --- Update State ---
      setRequests(processedRequests);
    } catch (err) {
      // This catch block now primarily handles errors during data *processing*
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
  }, [consultantId, type, error]);

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

    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRequestedAllocation = async (override: boolean) => {
    if (!selectedRequestForDialog) return;

    try {
      const endpoint =
        selectedRequestForDialog.type === AppointmentsType.SUBSCRIPTION
          ? `/api/bookings/subscriptions/${selectedRequestForDialog.id}/allocate`
          : `/api/bookings/consultations/${selectedRequestForDialog.id}/allocate`;

      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          isAuto: false,
          useRequestedSlots: true,
          override,
        }),
      });

      const data = await response.json();

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
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to allocate slots",
        variant: "destructive",
      });
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

  return (
    <Card className="border-0 shadow-none rounded-none">
      <CardHeader>
        <CardTitle className="text-xl font-bold">Requests</CardTitle>
        <CardDescription>
          Review and allocate slots for incoming session requests
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0 sm:p-6">
        {requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-100">
              <AlertTriangle className="h-8 w-8 text-zinc-400" />
            </div>
            <h4 className="text-lg font-semibold text-zinc-900">
              No pending requests
            </h4>
            <p className="mt-2 max-w-sm text-sm text-zinc-500">
              When consultees request sessions through your profile, they will
              appear here for slot allocation.
            </p>
          </div>
        ) : (
        <div className="overflow-x-auto w-full">
          <Table className="w-full min-w-[820px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[110px]">Type</TableHead>
                <TableHead className="w-[150px]">Title</TableHead>
                <TableHead className="w-[130px]">Requested By</TableHead>
                <TableHead className="w-[130px]">Requested At</TableHead>
                <TableHead>Requested Times</TableHead>
                <TableHead className="w-[90px] text-center">
                  Required Slots
                </TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="w-[150px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => (
                <TableRow key={request.id}>
                  <TableCell>{getRequestTypeLabel(request.type)}</TableCell>
                  <TableCell>{request.title}</TableCell>
                  <TableCell>{request.requestedBy.user.name}</TableCell>
                  <TableCell>
                    {new Date(request.requestedAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </TableCell>
                  <TableCell>
                    {/* Reschedule indicator */}
                    {request.tentativeSlotCount !== undefined &&
                      request.tentativeSlotCount > 0 &&
                      request.totalSlotCount !== undefined && (
                        <div className="mb-2">
                          {request.tentativeSlotCount ===
                          request.totalSlotCount ? (
                            <div className="flex items-center gap-1.5 text-xs font-medium text-blue-600 bg-blue-50 px-2 py-1 rounded-md">
                              <RefreshCw className="h-3 w-3" />
                              Full Reschedule (all {request.totalSlotCount}{" "}
                              session
                              {request.totalSlotCount !== 1 ? "s" : ""})
                            </div>
                          ) : request.tentativeSlotCount === 1 ? (
                            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded-md">
                              <AlertTriangle className="h-3 w-3" />
                              Individual Session (1 of {
                                request.totalSlotCount
                              }{" "}
                              needs new time)
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded-md">
                              <AlertTriangle className="h-3 w-3" />
                              Multiple Sessions ({
                                request.tentativeSlotCount
                              } of {request.totalSlotCount} need new times)
                            </div>
                          )}
                        </div>
                      )}

                    {request.requestedSlots &&
                    request.requestedSlots.length > 0 ? (
                      <div className="space-y-1">
                        {request.requestedSlots
                          .slice(0, 5)
                          .map((slot, index) => {
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
                            ... and {request.requestedSlots.length - 5} more
                            slot
                            {request.requestedSlots.length - 5 !== 1 ? "s" : ""}
                          </div>
                        )}
                      </div>
                    ) : request.requestedTimes &&
                      request.requestedTimes.length > 0 ? (
                      // Fallback to old format if requestedSlots not available
                      <div className="space-y-1">
                        {request.requestedTimes
                          .slice(0, 5)
                          .map((time, index) => {
                            const date = new Date(time);
                            const isValidDate = !isNaN(date.getTime());

                            return (
                              <div
                                key={`${request.id}-time-${index}`}
                                className="text-sm"
                              >
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
                            ... and {request.requestedTimes.length - 5} more
                            slot
                            {request.requestedTimes.length - 5 !== 1 ? "s" : ""}
                          </div>
                        )}
                      </div>
                    ) : request.type === AppointmentsType.SUBSCRIPTION &&
                      request.startDate &&
                      request.endDate ? (
                      <div className="text-sm">
                        <div className="font-medium text-blue-600">
                          Scheduling Period
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {request.startDate.toLocaleDateString()} -{" "}
                          {request.endDate.toLocaleDateString()}
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        Not available
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {request.requiredSlots}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <Badge
                        variant={getRequestStatusBadgeVariant(request.status)}
                      >
                        {getRequestStatusLabel(request.status)}
                      </Badge>
                      {request.status ===
                        AppointmentStatus.APPROVED_PENDING_PAYMENT && (
                        <PaymentRequiredBadge variant="full" />
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {request.status === AppointmentStatus.PENDING && (
                      <div className="flex flex-col gap-1.5">
                        {/* Hide "Use Requested Times" for directly booked consultations (Bug #8 fix) */}
                        {request.requestedTimes &&
                          request.requestedTimes.length > 0 &&
                          request.bookingSource === "REQUEST_SUBMITTED" && (
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
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        )}

        {/* Single Allocation Dialog - moved outside map loop to prevent multiple dialogs */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-[95vw] w-[1400px]">
            <DialogHeader>
              <DialogTitle>Allocate Slots</DialogTitle>
              <DialogDescription asChild>
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
                      <p className="text-xs text-blue-600">
                        Scheduling period:{" "}
                        {selectedRequest.startDate.toLocaleDateString()} -{" "}
                        {selectedRequest.endDate.toLocaleDateString()}
                      </p>
                    )}
                  </div>
                )}
              </DialogDescription>
            </DialogHeader>
            {selectedRequest && (
              <SafeUnifiedCalendar
                consultantId={consultantId}
                eventType={
                  selectedRequest.type.toLowerCase() as
                    | "consultation"
                    | "subscription"
                }
                eventId={selectedRequest.id}
                mode="allocate"
                onAllocationComplete={handleAllocationComplete}
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
                callsPerWeek={
                  selectedRequest.type === "SUBSCRIPTION"
                    ? selectedRequest.callsPerWeek
                    : undefined
                }
                sessionDurationInHours={
                  selectedRequest.type === "SUBSCRIPTION"
                    ? selectedRequest.sessionDurationInHours
                    : undefined
                }
                allowedStart={selectedRequest.startDate}
                allowedEnd={selectedRequest.endDate}
                totalSessions={
                  selectedRequest.type === "SUBSCRIPTION"
                    ? selectedRequest.totalSessions
                    : undefined
                }
              />
            )}
          </DialogContent>
        </Dialog>

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
