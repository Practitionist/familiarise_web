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
import { DetailedTimeSlotMeta, TimeSlotMeta } from "@/utils/timeSlotsMeta";
import { AppointmentsType, RequestStatus, ScheduleType } from "@prisma/client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { RequestedSlotsDialog } from "./components/RequestedSlotsDialog";
import { TimingsCalendar } from "./components/TimingsCalendar";
import {
  RequestedBy
} from "./types";
import {
  Request as UtilRequest,
  canAutoAllocate,
  fetchAllRequestData,
  generateWeeklyAvailabilitySlots,
  getRequestStatusBadgeVariant as getBadgeVariant,
  processAppointments,
  processConsultations,
  processCustomAvailabilitySlots,
  processSubscriptions,
  setupPolling,
} from "./utils";

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
  
  // State management
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<UtilRequest[]>([]);
  const [availableSlots, setAvailableSlots] = useState<TimeSlotMeta[]>([]);
  const [existingAppointments, setExistingAppointments] = useState<
    DetailedTimeSlotMeta[]
  >([]);
  const [selectedRequest, setSelectedRequest] = useState<UtilRequest | null>(null);
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  const [isAllocating, setIsAllocating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [requestedSlotsDialogOpen, setRequestedSlotsDialogOpen] = useState(false);
  const [selectedRequestForDialog, setSelectedRequestForDialog] = useState<UtilRequest | null>(null);
  const [consultantData, setConsultantData] = useState<{
    scheduleType: ScheduleType;
    timezone: string;
  }>({
    scheduleType: ScheduleType.WEEKLY,
    timezone: "UTC",
  });

  // Fetch and process all data
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await fetchAllRequestData(consultantId);
      
      if (!result.ok) {
        setError(result.error || "Unknown error occurred");
        return;
      }

      const { data } = result;
      if (!data) return;

      // Process requests
      const processedRequests: UtilRequest[] = [];

      if (data.consultations) {
        processedRequests.push(...processConsultations(data.consultations, type));
      }

      if (data.subscriptions) {
        processedRequests.push(...processSubscriptions(data.subscriptions, type));
      }

      // Process availability
      const processedAvailableSlots: TimeSlotMeta[] = [];
      
      if (data.weeklyAvailability) {
        const weeklySlots = generateWeeklyAvailabilitySlots(data.weeklyAvailability);
        processedAvailableSlots.push(...weeklySlots);
      }

      if (data.customAvailability) {
        const customSlots = processCustomAvailabilitySlots(data.customAvailability);
        processedAvailableSlots.push(...customSlots);
      }

      // Process appointments
      const processedAppointments = data.appointments ? processAppointments(data.appointments) : [];

      // Update consultant data
      if (data.consultant) {
        setConsultantData({
          scheduleType: data.consultant.scheduleType || ScheduleType.WEEKLY,
          timezone: data.consultant.user?.currentTimezone || "UTC",
        });
      }

      // Update state
      setRequests(processedRequests);
      setAvailableSlots(processedAvailableSlots);
      setExistingAppointments(processedAppointments);
    } catch (err) {
      console.error("Error in fetchData:", err);
      setError(err instanceof Error ? err.message : "Unknown error occurred");
    } finally {
      setLoading(false);
    }
  }, [consultantId, type]);

  // Combined useEffect for data fetching and polling
  useEffect(() => {
    fetchData();
    
    // Setup polling
    const cleanup = setupPolling(fetchData, 30000);
    
    return cleanup;
  }, [fetchData]);

  // Combined useEffect for onUpdate callback
  useEffect(() => {
    if (!loading && requests.length > 0) {
      onUpdate();
    }
  }, [loading, requests.length, onUpdate]);

  const handleSlotSelect = (slot: string) => {
    setSelectedSlots((prev) => {
      if (prev.includes(slot)) {
        return prev.filter((s) => s !== slot);
      } else {
        return [...prev, slot];
      }
    });
  };

  const handleManualAllocation = async () => {
    if (!selectedRequest || selectedSlots.length === 0) return;

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
          slots: selectedSlots 
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to allocate slots");
      }

      toast({
        title: "Success",
        description: `Successfully allocated ${selectedSlots.length} slots for ${selectedRequest.title}`,
      });

      // Reset state and refresh data
      setSelectedSlots([]);
      setSelectedRequest(null);
      setDialogOpen(false);
      await fetchData();
    } catch (err) {
      console.error("Manual allocation error:", err);
      toast({
        title: "Error",
        description:
          err instanceof Error ? err.message : "Failed to allocate slots",
        variant: "destructive",
      });
    } finally {
      setIsAllocating(false);
    }
  };

  const handleAutoAllocation = async () => {
    if (!selectedRequest) return;

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
          isAuto: true 
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to auto-allocate slots");
      }

      toast({
        title: "Success",
        description: `Successfully auto-allocated slots for ${selectedRequest.title}`,
      });

      // Reset state and refresh data
      setSelectedSlots([]);
      setSelectedRequest(null);
      setDialogOpen(false);
      await fetchData();
    } catch (err) {
      console.error("Auto allocation error:", err);
      toast({
        title: "Error",
        description:
          err instanceof Error ? err.message : "Failed to auto-allocate slots",
        variant: "destructive",
      });
    } finally {
      setIsAllocating(false);
    }
  };

  const handleRequestedAllocation = async (override: boolean) => {
    if (!selectedRequestForDialog || !selectedRequestForDialog.requestedTimes) return;

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
          override 
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to allocate requested slots");
      }

      toast({
        title: "Success",
        description: `Successfully allocated requested slots for ${selectedRequestForDialog.title}`,
      });

      // Reset state and refresh data
      setRequestedSlotsDialogOpen(false);
      setSelectedRequestForDialog(null);
      await fetchData();
    } catch (err) {
      console.error("Requested allocation error:", err);
      toast({
        title: "Error",
        description:
          err instanceof Error ? err.message : "Failed to allocate requested slots",
        variant: "destructive",
      });
    } finally {
      setIsAllocating(false);
    }
  };

  // Check if manual allocation quota is met
  const isQuotaMet = selectedRequest?.requiredSlots === selectedSlots.length;

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Slot Allocation</CardTitle>
          <CardDescription>
            Loading requests, schedules, and appointment data...
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center p-8 space-y-3">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            <p className="text-sm text-muted-foreground">
              Fetching requests, availability slots, and existing appointments...
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Slot Allocation</CardTitle>
          <CardDescription>Unable to load slot allocation data</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-red-50 border border-red-200 rounded-md p-4">
            <h3 className="font-semibold text-red-800 mb-2">Loading Error</h3>
            <p className="text-red-700 text-sm mb-3">{error}</p>
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => {
                  setError(null);
                  fetchData();
                }}
              >
                Try Again
              </Button>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => window.location.reload()}
              >
                Refresh Page
              </Button>
            </div>
          </div>
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
        {requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 text-center space-y-3">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 mb-1">No Pending Requests</h3>
              <p className="text-sm text-gray-600">
                There are currently no {type === "all" ? "" : type} requests requiring slot allocation.
              </p>
            </div>
          </div>
        ) : (
          <>
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
                    <Badge variant={getBadgeVariant(request.status)}>
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

          {/* Slot Allocation Dialog */}
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
                  Choose {selectedRequest?.requiredSlots || 0} slots for{" "}
                  {selectedRequest?.type.toLowerCase() || "request"}
                </DialogDescription>
              </DialogHeader>
              <TimingsCalendar
                availableSlots={availableSlots}
                existingAppointments={existingAppointments}
                onSlotSelect={handleSlotSelect}
                selectedSlots={selectedSlots}
                requiredSlots={selectedRequest?.requiredSlots || 0}
                scheduleType={consultantData.scheduleType}
              />
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={handleAutoAllocation}
                  disabled={!canAutoAllocate(selectedRequest, availableSlots, existingAppointments) || isAllocating}
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
        </>
        )}
      </CardContent>
    </Card>
  );
}

