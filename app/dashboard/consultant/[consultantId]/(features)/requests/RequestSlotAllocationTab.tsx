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
  DialogTrigger,
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
import { AppointmentsType, RequestStatus, ScheduleType } from "@prisma/client";
import { useParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { TimingsCalendar } from "./components/TimingsCalendar";
import { RequestedSlotsDialog } from "./components/RequestedSlotsDialog";
import {
    ConsultationApiResponse,
    SubscriptionApiResponse,
    AvailabilityApiResponse,
    AppointmentInfo,
    ConsultantApiResponse,
    SlotInterval,
    RequestedBy
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
}

// interface SlotInterval { ... } // Removed - Now imported

type RequestType = "all" | "consultation" | "subscription";

interface RequestSlotAllocationTabProps {
  type: RequestType;
  onUpdate: () => void;
}

// Helper function to fetch and process data
async function fetchDataFromApi<T>(url: string): Promise<{ ok: boolean; data: T | null; error?: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to fetch ${url}:`, errorText);
      return { ok: false, data: null, error: `Failed to fetch data (status ${response.status})` };
    }
    const data = await response.json();
    return { ok: true, data: data.data as T, error: undefined }; // Assuming API wraps data in { data: ... }
  } catch (err) {
    console.error(`Error fetching ${url}:`, err);
    const message = err instanceof Error ? err.message : "An unknown network error occurred";
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
  const [availableSlots, setAvailableSlots] = useState<SlotInterval[]>([]);
  const [existingAppointments, setExistingAppointments] = useState<SlotInterval[]>([]);
  const [selectedRequest, setSelectedRequest] = useState<Request | null>(null);
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  const [isAllocating, setIsAllocating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [requestedSlotsDialogOpen, setRequestedSlotsDialogOpen] =
    useState(false);
  const [selectedRequestForDialog, setSelectedRequestForDialog] =
    useState<Request | null>(null);
  const [consultantData, setConsultantData] = useState<{
    scheduleType: ScheduleType;
    timezone: string;
  }>({
    scheduleType: ScheduleType.WEEKLY,
    timezone: "UTC",
  });

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
        consultantResult,
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
        fetchDataFromApi<AppointmentInfo[]>(
          `/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`,
        ),
        fetchDataFromApi<ConsultantApiResponse>(
          `/api/user/consultants/${consultantId}`,
        ),
      ]);

      let combinedError: string | null = null;
      const updateError = (newError?: string) => {
         if (newError) {
            combinedError = combinedError ? `${combinedError}; ${newError}` : newError;
         }
      }

      updateError(consultationsResult.error);
      updateError(subscriptionsResult.error);
      updateError(weeklyAvailabilityResult.error);
      updateError(customAvailabilityResult.error);
      updateError(appointmentsResult.error);
      updateError(consultantResult.error);

      // --- Process Data ---
      const processedRequests: Request[] = [];

      // Process consultations
      if (consultationsResult.ok && consultationsResult.data && (type === "all" || type === "consultation")) {
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
            requiredSlots: 1, // Consultations always require 1 slot
          })),
        );
      }

      // Process subscriptions
      if (subscriptionsResult.ok && subscriptionsResult.data && (type === "all" || type === "subscription")) {
        processedRequests.push(
          ...subscriptionsResult.data.map((subscription) => ({
            id: subscription.id,
            type: AppointmentsType.SUBSCRIPTION,
            title: subscription.subscriptionPlan?.title || "Untitled Plan",
            requestedBy: subscription.requestedBy,
            requestedAt: subscription.requestedAt,
            requestedTimes:
              subscription.appointments?.flatMap(
                (appt) => appt.slotsOfAppointment?.map((slot) => slot.slotStartTimeInUTC) || [],
              ) || [],
            status: subscription.requestStatus,
            requiredSlots:
              (subscription.subscriptionPlan?.callsPerWeek ?? 0) *
                4 *
                (subscription.subscriptionPlan?.durationInMonths ?? 0) || 0,
          })),
        );
      }

      // Process availability
      const processedAvailableSlots: SlotInterval[] = [];
      if (weeklyAvailabilityResult.ok && weeklyAvailabilityResult.data) {
        processedAvailableSlots.push(...weeklyAvailabilityResult.data);
      }
      if (customAvailabilityResult.ok && customAvailabilityResult.data) {
        processedAvailableSlots.push(...customAvailabilityResult.data);
      }

      // Process appointments
      const processedExistingAppointments: SlotInterval[] = [];
      if (appointmentsResult.ok && appointmentsResult.data) {
        processedExistingAppointments.push(
          ...appointmentsResult.data.flatMap(
            (appt) => appt.slotsOfAppointment || [],
          ),
        );
      }

       // Process consultant data
      if (consultantResult.ok && consultantResult.data) {
        setConsultantData({
          scheduleType: consultantResult.data.scheduleType || ScheduleType.WEEKLY,
          timezone: consultantResult.data.user?.currentTimezone || "UTC",
        });
      } else {
         // Handle potential error in fetching consultant data, maybe set defaults or show specific error
         console.error("Could not fetch consultant schedule/timezone info.");
         // Keep default or previous state for consultantData
      }

      // --- Update State ---
      setRequests(processedRequests);
      setAvailableSlots(processedAvailableSlots);
      setExistingAppointments(processedExistingAppointments);

      if (combinedError) {
        setError(combinedError)
      }

    } catch (err) {
      // Catch unexpected errors during processing (Promise.all itself shouldn't throw for individual failures with this setup)
      console.error("Unexpected error during fetch/process:", err);
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setLoading(false);
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
      const trulyAvailableSlots = availableSlots.filter(availSlot =>
          !existingAppointments.some(existingSlot => {
              const availStart = new Date(availSlot.slotStartTimeInUTC);
              const availEnd = new Date(availSlot.slotEndTimeInUTC);
              const existingStart = new Date(existingSlot.slotStartTimeInUTC);
              const existingEnd = new Date(existingSlot.slotEndTimeInUTC);
              // Check for overlap: (StartA < EndB) and (StartB < EndA)
              return availStart < existingEnd && existingStart < availEnd;
          })
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
                    request.requestedTimes.map((time, index) => (
                      <div key={time + index} className="text-sm">
                        {new Date(time).toLocaleString()}
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      Not available
                    </div>
                  )}
                </TableCell>
                <TableCell>{request.requiredSlots}</TableCell>
                <TableCell>
                  <Badge
                    variant={getRequestStatusBadgeVariant(request.status)}
                  >
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
                      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                        <DialogTrigger asChild>
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
                        </DialogTrigger>
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
                              Choose {request.requiredSlots} slots for{" "}
                              {request.type.toLowerCase()}
                            </DialogDescription>
                          </DialogHeader>
                          <TimingsCalendar
                            availableSlots={availableSlots}
                            existingAppointments={existingAppointments}
                            onSlotSelect={handleSlotSelect}
                            selectedSlots={selectedSlots}
                            requiredSlots={request.requiredSlots}
                            scheduleType={consultantData.scheduleType}
                          />
                          <DialogFooter>
                            <Button
                              variant="outline"
                              onClick={handleAutoAllocation}
                              disabled={!canAutoAllocate() || isAllocating}
                            >
                              {isAllocating ? "Allocating..." : "Auto Allocate"}
                            </Button>
                            <Button
                              onClick={handleManualAllocation}
                              disabled={!isQuotaMet || isAllocating}
                            >
                              {isAllocating
                                ? "Allocating..."
                                : "Allocate Manual Slots"}
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
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

        <RequestedSlotsDialog
          open={requestedSlotsDialogOpen}
          onOpenChange={setRequestedSlotsDialogOpen}
          requestId={selectedRequestForDialog?.id || ""}
          requestType={
            selectedRequestForDialog?.type || AppointmentsType.CONSULTATION
          }
          requestedSlots={selectedRequestForDialog?.requestedTimes || []}
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

// Helper function for auto-allocation check
function checkCanAutoAllocate(
    selectedRequest: Request | null,
    availableSlots: SlotInterval[],
    existingAppointments: SlotInterval[]
): boolean {
    if (!selectedRequest) return false;
    // Filter available slots that do NOT overlap with any existing appointment
    const trulyAvailableSlots = availableSlots.filter(availSlot =>
        !existingAppointments.some(existingSlot => {
            const availStart = new Date(availSlot.slotStartTimeInUTC);
            const availEnd = new Date(availSlot.slotEndTimeInUTC);
            const existingStart = new Date(existingSlot.slotStartTimeInUTC);
            const existingEnd = new Date(existingSlot.slotEndTimeInUTC);
            // Check for overlap: (StartA < EndB) and (StartB < EndA)
            return availStart < existingEnd && existingStart < availEnd;
        })
    );
    // Check if the count of non-overlapping available slots is sufficient
    return trulyAvailableSlots.length >= selectedRequest.requiredSlots;
}
