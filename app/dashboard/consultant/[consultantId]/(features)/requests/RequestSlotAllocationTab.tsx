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
import { AppointmentsType, RequestStatus } from "@prisma/client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { RequestedSlotsDialog } from "./components/RequestedSlotsDialog";
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

interface Request {
  id: string;
  type: AppointmentsType;
  title: string;
  requestedBy: RequestedBy;
  requestedAt: string;
  requestedTimes?: string[];
  status: RequestStatus;
  requiredSlots: number;
  allocatedSlots?: string[];
  durationInMonths?: number;
  callsPerWeek?: number;
  sessionDurationInHours?: number;
  durationInHours?: number;
  startDate?: Date;
  endDate?: Date;
  bookingSource?: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED"; // Booking source - direct checkout or request submitted
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
    console.error(`Error fetching ${url}:`, err);
    let message = "An unknown error occurred while fetching data.";
    // Specifically check for the browser's network error
    if (err instanceof TypeError && err.message === "Failed to fetch") {
      message =
        "Network error: Could not connect to the server. Please check your internet connection.";
    } else if (err instanceof Error) {
      // Use message from other error types
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
          `/api/events/consultations?consultantProfileId=${consultantId}&status=PENDING`,
        ),
        fetchDataFromApi<SubscriptionApiResponse[]>(
          `/api/events/subscriptions?consultantProfileId=${consultantId}&status=PENDING`,
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
          ...consultationsResult.data.map((consultation) => ({
            id: consultation.id,
            type: AppointmentsType.CONSULTATION,
            title: consultation.consultationPlan?.title || "Untitled Plan",
            requestedBy: consultation.requestedBy,
            requestedAt: consultation.requestedAt,
            requestedTimes:
              consultation.appointment?.slotsOfAppointment?.map(
                (slot) => slot.startsAt,
              ) || [],
            status: consultation.requestStatus,
            requiredSlots: Math.ceil(
              (consultation.consultationPlan?.durationInHours || 1) / 0.5,
            ), // Convert hours to 30-min slots
            durationInHours:
              consultation.consultationPlan?.durationInHours || 1,
            bookingSource: consultation.bookingSource, // Map bookingSource enum
            // No scheduling period for consultations (one-time event)
          })),
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

            return {
              id: subscription.id,
              type: AppointmentsType.SUBSCRIPTION,
              title: subscription.subscriptionPlan?.title || "Untitled Plan",
              requestedBy: subscription.requestedBy,
              requestedAt: subscription.requestedAt,
              requestedTimes:
                subscription.appointments?.flatMap(
                  (appt) =>
                    appt.slotsOfAppointment?.map((slot) => slot.startsAt) || [],
                ) || [],
              status: subscription.requestStatus,
              // FIXED: Use accurate week counting instead of hardcoded * 4
              requiredSlots: (() => {
                const startDate = subscription.schedulingPeriodStartsAt
                  ? new Date(subscription.schedulingPeriodStartsAt)
                  : undefined;
                const endDate = subscription.schedulingPeriodEndsAt
                  ? new Date(subscription.schedulingPeriodEndsAt)
                  : undefined;
                const callsPerWeek =
                  subscription.subscriptionPlan?.callsPerWeek ?? 0;

                if (startDate && endDate) {
                  const weeks = countSundayWeeksInclusive(startDate, endDate);
                  return weeks * callsPerWeek * slotsPerSession;
                }
                // Fallback to month-based calculation if dates not set
                return (
                  callsPerWeek *
                    4 *
                    (subscription.subscriptionPlan?.durationInMonths ?? 0) *
                    slotsPerSession || 0
                );
              })(),
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
  }, [consultantId, type]);

  useEffect(() => {
    fetchData();
    // Set up polling for real-time updates
    const REQUEST_POLL_INTERVAL = parseInt(
      process.env.NEXT_PUBLIC_REQUEST_POLL_INTERVAL ?? "300000",
    ); // 5 minutes
    const interval = setInterval(fetchData, REQUEST_POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRequestedAllocation = async (override: boolean) => {
    if (!selectedRequestForDialog) return;

    try {
      const endpoint =
        selectedRequestForDialog.type === AppointmentsType.SUBSCRIPTION
          ? `/api/events/subscriptions/${selectedRequestForDialog.id}/allocate`
          : `/api/events/consultations/${selectedRequestForDialog.id}/allocate`;

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
        title: "Success",
        description: `Slots have been allocated as requested${override ? " (with override)" : ""}`,
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

  // Handle allocation complete from UnifiedCalendar
  const handleAllocationComplete = async () => {
    toast({
      title: "Success",
      description: "Slots have been allocated successfully",
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
      <Card>
        <CardHeader>
          <CardTitle>Slot Allocation</CardTitle>
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
      <Card>
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
    <Card>
      <CardHeader>
        <CardTitle>Slot Allocation</CardTitle>
        <CardDescription>
          Allocate slots for subscription and class requests
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Requested By</TableHead>
              <TableHead>Requested At</TableHead>
              <TableHead>Requested Times</TableHead>
              <TableHead>Required Slots</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((request) => (
              <TableRow key={request.id}>
                <TableCell>{request.type}</TableCell>
                <TableCell>{request.title}</TableCell>
                <TableCell>{request.requestedBy.user.name}</TableCell>
                <TableCell>
                  {new Date(request.requestedAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  {request.requestedTimes &&
                  request.requestedTimes.length > 0 ? (
                    <div className="space-y-1">
                      {request.requestedTimes.slice(0, 5).map((time, index) => {
                        // Validate and parse date string (Bug #5 fix)
                        const date = new Date(time);
                        const isValidDate = !isNaN(date.getTime());

                        return (
                          <div
                            key={`${request.id}-time-${index}`}
                            className="text-sm"
                          >
                            {isValidDate
                              ? date.toLocaleString()
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
                <TableCell>{request.requiredSlots}</TableCell>
                <TableCell>
                  <Badge variant={getRequestStatusBadgeVariant(request.status)}>
                    {request.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {request.status === RequestStatus.PENDING && (
                    <>
                      {/* Hide "Use Requested Times" button for directly booked consultations (Bug #8 fix) */}
                      {request.requestedTimes &&
                        request.requestedTimes.length > 0 &&
                        request.bookingSource === "REQUEST_SUBMITTED" && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="mr-2"
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
                        onClick={() => {
                          setSelectedRequest(request);
                          setDialogOpen(true);
                        }}
                      >
                        Allocate Slots
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {/* Single Allocation Dialog - moved outside map loop to prevent multiple dialogs */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-7xl">
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
                className="min-h-[500px]"
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
  status: RequestStatus,
): "outline" | "default" | "destructive" {
  switch (status) {
    case RequestStatus.PENDING:
      return "outline";
    case RequestStatus.APPROVED:
      return "default";
    case RequestStatus.REJECTED:
    case RequestStatus.CANCELLED:
    case RequestStatus.EXPIRED:
      return "destructive";
    default:
      return "outline"; // Default case
  }
}
