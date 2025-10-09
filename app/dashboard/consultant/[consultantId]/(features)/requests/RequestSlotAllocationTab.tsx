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
  DialogFooter,
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
import { TAppointment } from "@/types/appointment";
import { DetailedTimeSlotMeta, TimeSlotMeta } from "@/utils/timeSlotsMeta";
import { AppointmentsType, RequestStatus } from "@prisma/client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { RequestedSlotsDialog } from "./components/RequestedSlotsDialog";
import { TimingsCalendar } from "./components/TimingsCalendar";
import {
  AvailabilityApiResponse,
  ConsultationApiResponse,
  RequestedBy,
  SubscriptionApiResponse,
} from "./types";

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
  const [availableSlots, setAvailableSlots] = useState<TimeSlotMeta[]>([]);
  const [existingAppointments, setExistingAppointments] = useState<
    DetailedTimeSlotMeta[]
  >([]);
  const [selectedRequest, setSelectedRequest] = useState<Request | null>(null);
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  const [isAllocating, setIsAllocating] = useState(false);
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
      // Fetch data in parallel
      const [
        consultationsResult,
        subscriptionsResult,
        weeklyAvailabilityResult,
        customAvailabilityResult,
        appointmentsResult,
      ] = await Promise.all([
        fetchDataFromApi<ConsultationApiResponse[]>(
          `/api/events/consultations?consultantProfileId=${consultantId}&status=PENDING`,
        ),
        fetchDataFromApi<SubscriptionApiResponse[]>(
          `/api/events/subscriptions?consultantProfileId=${consultantId}&status=PENDING`,
        ),
        fetchDataFromApi<AvailabilityApiResponse[]>(
          `/api/slots/availability/weekly?consultantProfileId=${consultantId}`,
        ),
        fetchDataFromApi<AvailabilityApiResponse[]>(
          `/api/slots/availability/custom?consultantProfileId=${consultantId}`,
        ),
        fetchDataFromApi<TAppointment[]>(
          `/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`,
        ),
      ]);

      // Check results for the first error
      const results = [
        consultationsResult,
        subscriptionsResult,
        weeklyAvailabilityResult,
        customAvailabilityResult,
        appointmentsResult,
      ];

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
                (slot) => slot.slotStartTimeInUTC,
              ) || [],
            status: consultation.requestStatus,
            requiredSlots: Math.ceil(
              (consultation.consultationPlan?.durationInHours || 1) / 0.5,
            ), // Convert hours to 30-min slots
            durationInHours:
              consultation.consultationPlan?.durationInHours || 1,
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
                    appt.slotsOfAppointment?.map(
                      (slot) => slot.slotStartTimeInUTC,
                    ) || [],
                ) || [],
              status: subscription.requestStatus,
              requiredSlots:
                (subscription.subscriptionPlan?.callsPerWeek ?? 0) *
                  4 *
                  (subscription.subscriptionPlan?.durationInMonths ?? 0) *
                  slotsPerSession || 0,
              durationInMonths: subscription.subscriptionPlan?.durationInMonths,
              callsPerWeek: subscription.subscriptionPlan?.callsPerWeek,
              sessionDurationInHours: sessionDuration,
              // Scheduling period for subscriptions
              startDate: subscription.startDate
                ? new Date(subscription.startDate)
                : undefined,
              endDate: subscription.endDate
                ? new Date(subscription.endDate)
                : undefined,
            };
          }),
        );
      }

      // Process availability
      const processedAvailableSlots: TimeSlotMeta[] = [];
      if (weeklyAvailabilityResult.ok && weeklyAvailabilityResult.data) {
        processedAvailableSlots.push(
          ...weeklyAvailabilityResult.data.map((slot) => ({
            startTime: slot.slotStartTimeInUTC,
            endTime: slot.slotEndTimeInUTC,
            // Add other properties if TimeSlotMeta requires them
          })),
        );
      }
      if (customAvailabilityResult.ok && customAvailabilityResult.data) {
        processedAvailableSlots.push(
          ...customAvailabilityResult.data.map((slot) => ({
            startTime: slot.slotStartTimeInUTC,
            endTime: slot.slotEndTimeInUTC,
          })),
        );
      }

      // Process appointments
      const processedExistingAppointments: DetailedTimeSlotMeta[] = [];
      if (appointmentsResult.ok && appointmentsResult.data) {
        processedExistingAppointments.push(
          ...appointmentsResult.data.flatMap((appt: TAppointment) =>
            (appt.slotsOfAppointment || []).map(
              (slot): DetailedTimeSlotMeta => {
                let title = "Booked Slot"; // Default
                const type =
                  appt.appointmentType || AppointmentsType.CONSULTATION;
                const id = appt.id || "unknown-appt-" + slot.id;

                if (
                  appt.appointmentType === "CONSULTATION" &&
                  appt.consultation?.consultationPlan?.title
                ) {
                  title = `Consultation: ${appt.consultation.consultationPlan.title}`;
                  if (appt.consultation.requestedBy?.user?.name) {
                    title += ` with ${appt.consultation.requestedBy.user.name}`;
                  }
                } else if (
                  appt.appointmentType === "SUBSCRIPTION" &&
                  appt.subscription?.subscriptionPlan?.title
                ) {
                  title = `Subscription: ${appt.subscription.subscriptionPlan.title}`;
                  if (appt.subscription.requestedBy?.user?.name) {
                    title += ` for ${appt.subscription.requestedBy.user.name}`;
                  }
                } else if (
                  appt.appointmentType === "WEBINAR" &&
                  appt.webinar?.webinarPlan?.title
                ) {
                  title = `Webinar: ${appt.webinar.webinarPlan.title}`;
                } else if (
                  appt.appointmentType === "CLASS" &&
                  appt.class?.classPlan?.name
                ) {
                  title = `Class: ${appt.class.classPlan.name}`;
                }

                return {
                  startTime: slot.slotStartTimeInUTC,
                  endTime: slot.slotEndTimeInUTC,
                  appointmentDetails: {
                    id: id,
                    type: type,
                    title: title,
                  },
                };
              },
            ),
          ),
        );
      }

      // --- Update State ---
      setRequests(processedRequests);
      setAvailableSlots(processedAvailableSlots);
      setExistingAppointments(processedExistingAppointments);
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

  const handleSlotSelect = (slot: string) => {
    setSelectedSlots((prevSlots) => {
      if (prevSlots.includes(slot)) {
        return prevSlots.filter((s) => s !== slot);
      } else if (
        selectedRequest &&
        prevSlots.length < selectedRequest.requiredSlots
      ) {
        return [...prevSlots, slot].sort();
      }
      return prevSlots;
    });
  };

  const handleManualAllocation = async () => {
    if (!selectedRequest) return;
    if (isAllocating) return;
    if (selectedSlots.length !== selectedRequest.requiredSlots) return;

    setIsAllocating(true);
    try {
      const endpoint =
        selectedRequest.type === AppointmentsType.SUBSCRIPTION
          ? `/api/events/subscriptions/${selectedRequest.id}/allocate`
          : `/api/events/consultations/${selectedRequest.id}/allocate`;

      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          isAuto: false,
          slots: selectedSlots,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to allocate slots");
      }

      // Success handling
      toast({
        title: "Success",
        description: "Slots have been allocated manually",
        variant: "default",
      });

      // Close dialog and reset state
      setDialogOpen(false);
      setSelectedRequest(null);
      setSelectedSlots([]);

      // Remove request from list
      setRequests((prev) => prev.filter((r) => r.id !== selectedRequest.id));

      // Notify parent
      onUpdate();
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to allocate slots",
        variant: "destructive",
      });
    } finally {
      setIsAllocating(false);
    }
  };

  const handleAutoAllocation = async () => {
    if (!selectedRequest) return;
    if (isAllocating) return;

    setIsAllocating(true);
    try {
      const endpoint =
        selectedRequest.type === AppointmentsType.SUBSCRIPTION
          ? `/api/events/subscriptions/${selectedRequest.id}/allocate`
          : `/api/events/consultations/${selectedRequest.id}/allocate`;

      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isAuto: true }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to allocate slots");
      }

      // Success handling
      toast({
        title: "Success",
        description: "Slots have been allocated automatically",
        variant: "default",
      });

      // Close dialog and reset state
      setDialogOpen(false);
      setSelectedRequest(null);
      setSelectedSlots([]);

      // Remove request from list
      setRequests((prev) => prev.filter((r) => r.id !== selectedRequest.id));

      // Notify parent
      onUpdate();
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to allocate slots",
        variant: "destructive",
      });
    } finally {
      setIsAllocating(false);
    }
  };

  const handleRequestedAllocation = async (override: boolean) => {
    if (!selectedRequestForDialog) return;
    if (isAllocating) return;

    setIsAllocating(true);
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
    } finally {
      setIsAllocating(false);
    }
  };

  // Check if auto-allocation is possible
  const canAutoAllocate = () => {
    if (!selectedRequest) return false;
    // Filter available slots that do NOT overlap with any existing appointment
    const trulyAvailableSlots = availableSlots.filter(
      (availSlot) =>
        !existingAppointments.some((existingSlot) => {
          // Compare using startTime/endTime
          // FIX: Ensure Date objects are compared, handle potential string types
          const availStart =
            availSlot.startTime instanceof Date
              ? availSlot.startTime
              : new Date(availSlot.startTime);
          const availEnd =
            availSlot.endTime instanceof Date
              ? availSlot.endTime
              : new Date(availSlot.endTime);
          const existingStart =
            existingSlot.startTime instanceof Date
              ? existingSlot.startTime
              : new Date(existingSlot.startTime);
          const existingEnd =
            existingSlot.endTime instanceof Date
              ? existingSlot.endTime
              : new Date(existingSlot.endTime);
          // Check for overlap: (StartA < EndB) and (StartB < EndA)
          return availStart < existingEnd && existingStart < availEnd;
        }),
    );
    // Check if the count of non-overlapping available slots is sufficient
    return trulyAvailableSlots.length >= selectedRequest.requiredSlots;
  };

  // Check if manual allocation quota is met
  const isQuotaMet = selectedRequest?.requiredSlots === selectedSlots.length;

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
                      {request.requestedTimes.slice(0, 5).map((time, index) => (
                        <div key={time + index} className="text-sm">
                          {new Date(time).toLocaleString()}
                        </div>
                      ))}
                      {request.requestedTimes.length > 5 && (
                        <div className="text-xs text-muted-foreground">
                          ... and {request.requestedTimes.length - 5} more slot
                          {request.requestedTimes.length - 5 !== 1 ? "s" : ""}
                        </div>
                      )}
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
                      {request.requestedTimes &&
                        request.requestedTimes.length > 0 && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="mr-2"
                            onClick={() => {
                              setSelectedRequestForDialog(request);
                              setRequestedSlotsDialogOpen(true);
                            }}
                            disabled={isAllocating}
                          >
                            {isAllocating
                              ? "Allocating..."
                              : "Use Requested Times"}
                          </Button>
                        )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedRequest(request);
                          setSelectedSlots([]);
                          setDialogOpen(true);
                        }}
                      >
                        Allocate Slots
                      </Button>
                    </>
                  )}
                  {request.status === RequestStatus.APPROVED &&
                    request.allocatedSlots && (
                      <div className="text-sm text-muted-foreground">
                        {request.allocatedSlots.length} slots allocated
                      </div>
                    )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {/* Single Allocation Dialog - moved outside map loop to prevent multiple dialogs */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent
            className="max-w-3xl"
            onInteractOutside={(e) => {
              // Prevent closing dialog while allocating
              if (isAllocating) {
                e.preventDefault();
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Allocate Slots</DialogTitle>
              <DialogDescription>
                {selectedRequest && (
                  <div className="space-y-1">
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
                          ({Math.ceil(selectedRequest.sessionDurationInHours / 0.5)}{" "}
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
              <TimingsCalendar
                consultantId={consultantId}
                eventType={
                  selectedRequest.type.toLowerCase() as
                    | "consultation"
                    | "subscription"
                }
                eventId={selectedRequest.id}
                onSlotSelect={handleSlotSelect}
                selectedSlots={selectedSlots}
                requiredSlots={selectedRequest.requiredSlots}
                durationInMonths={
                  selectedRequest.type === "SUBSCRIPTION"
                    ? selectedRequest.durationInMonths
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
                    : selectedRequest.durationInHours
                }
                allowedStart={selectedRequest.startDate}
                allowedEnd={selectedRequest.endDate}
              />
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDialogOpen(false)}
                disabled={isAllocating}
              >
                Cancel
              </Button>
              <Button
                onClick={handleAutoAllocation}
                disabled={!canAutoAllocate() || isAllocating}
              >
                {isAllocating ? "Allocating..." : "Auto Allocate"}
              </Button>
              <Button
                onClick={handleManualAllocation}
                disabled={!isQuotaMet || isAllocating}
              >
                {isAllocating ? "Allocating..." : "Allocate Manual Slots"}
              </Button>
            </DialogFooter>
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
