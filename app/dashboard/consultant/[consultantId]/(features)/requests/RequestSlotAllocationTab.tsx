import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { toast } from '@/components/ui/use-toast';
import { AppointmentsType, RequestStatus } from "@prisma/client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Calendar } from './components/Calendar';

interface Request {
  id: string;
  type: AppointmentsType;
  title: string;
  requestedBy: {
    id: string;
    user: {
      id: string;
      name: string;
      image?: string;
    };
  };
  requestedAt: string;
  requestedTimes?: string[];
  status: RequestStatus;
  requiredSlots: number;
  allocatedSlots?: string[];
}

interface Slot {
  id: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
}

type RequestType = 'all' | 'consultation' | 'subscription';

interface RequestSlotAllocationTabProps {
  type: RequestType;
  onUpdate: () => void;
}

export function RequestSlotAllocationTab({ type, onUpdate }: RequestSlotAllocationTabProps) {
  const params = useParams();
  const consultantId = params.consultantId as string;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<Request[]>([]);
  const [availableSlots, setAvailableSlots] = useState<Slot[]>([]);
  const [existingAppointments, setExistingAppointments] = useState<Slot[]>([]);
  const [selectedRequest, setSelectedRequest] = useState<Request | null>(null);
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  const [isAllocating, setIsAllocating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [consultantData, setConsultantData] = useState<{
    scheduleType: 'WEEKLY' | 'CUSTOM';
    timezone: string;
  }>({
    scheduleType: 'WEEKLY',
    timezone: 'UTC'
  });

  // Fetch requests, available slots, and existing appointments
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        // Fetch data in parallel
        const [consultationsRes, subscriptionsRes, availabilityRes, appointmentsRes, consultantRes] = await Promise.all([
          fetch(`/api/events/consultations?consultantProfileId=${consultantId}&status=PENDING`),
          fetch(`/api/events/subscriptions?consultantProfileId=${consultantId}&status=PENDING`),
          Promise.all([
            fetch(`/api/slots/availability/weekly?consultantProfileId=${consultantId}`),
            fetch(`/api/slots/availability/custom?consultantProfileId=${consultantId}`)
          ]).then(async ([weeklyRes, customRes]) => {
            const weeklyData = weeklyRes.ok ? await weeklyRes.json() : { data: [] };
            const customData = customRes.ok ? await customRes.json() : { data: [] };
            return {
              ok: weeklyRes.ok || customRes.ok,
              data: [...weeklyData.data, ...customData.data]
            };
          }),
          // Only fetch approved appointments to show existing bookings
          fetch(`/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`),
          fetch(`/api/user/consultants/${consultantId}`)
        ]);

        // Handle consultation requests
        let filteredRequests = [];
        if (consultationsRes.ok) {
          const consultationsData = await consultationsRes.json();
          if (type === 'all' || type === 'consultation') {
            filteredRequests.push(...consultationsData.data.map((consultation: any) => ({
              id: consultation.id,
              type: AppointmentsType.CONSULTATION,
              title: consultation.consultationPlan?.title || 'Untitled Plan',
              requestedBy: consultation.requestedBy,
              requestedAt: consultation.requestedAt,
              requestedTimes: consultation.appointment?.slotsOfAppointment?.map((slot: any) => slot.slotStartTimeInUTC) || [],
              status: consultation.requestStatus,
              requiredSlots: 1 // Consultations always require 1 slot
            })));
          }
        } else {
          console.error('Failed to fetch consultations:', await consultationsRes.text());
        }

        // Handle subscription requests
        if (subscriptionsRes.ok) {
          const subscriptionsData = await subscriptionsRes.json();
          if (type === 'all' || type === 'subscription') {
            filteredRequests.push(...subscriptionsData.data.map((subscription: any) => ({
              id: subscription.id,
              type: AppointmentsType.SUBSCRIPTION,
              title: subscription.subscriptionPlan?.title || 'Untitled Plan',
              requestedBy: subscription.requestedBy,
              requestedAt: subscription.requestedAt,
              requestedTimes: subscription.appointments?.flatMap((appt: any) => 
                appt.slotsOfAppointment?.map((slot: any) => slot.slotStartTimeInUTC) || []
              ) || [],
              status: subscription.requestStatus,
              requiredSlots: subscription.subscriptionPlan?.callsPerWeek * 4 * subscription.subscriptionPlan?.durationInMonths || 0
            })));
          }
        } else {
          console.error('Failed to fetch subscriptions:', await subscriptionsRes.text());
        }

        // Handle availability
        let availableSlots: Slot[] = [];
        if (availabilityRes.ok) {
          // Convert weekly slots to actual dates for next 3 months
          if (availabilityRes.data.length > 0) {
            const convertedSlots: Slot[] = [];
            const startDate = new Date();
            const endDate = new Date();
            endDate.setMonth(endDate.getMonth() + 3); // Show slots for next 3 months

            const dayMap: { [key: string]: number } = {
              'SUNDAY': 0,
              'MONDAY': 1,
              'TUESDAY': 2,
              'WEDNESDAY': 3,
              'THURSDAY': 4,
              'FRIDAY': 5,
              'SATURDAY': 6
            };

            // For each weekly slot
            availabilityRes.data.forEach(slot => {
              let currentDate = new Date(startDate);
              
              // Get to the first occurrence of this weekday
              const dayOffset = dayMap[slot.dayOfWeekforStartTimeInUTC];
              const diff = dayOffset - currentDate.getDay();
              currentDate.setDate(currentDate.getDate() + (diff >= 0 ? diff : diff + 7));

              // Set the time
              const timeOnly = new Date(slot.slotStartTimeInUTC);
              const endTimeOnly = new Date(slot.slotEndTimeInUTC);
              const duration = endTimeOnly.getTime() - timeOnly.getTime();

              // Create slots for each week until endDate
              while (currentDate < endDate) {
                const slotDate = new Date(currentDate);
                slotDate.setHours(timeOnly.getHours(), timeOnly.getMinutes(), 0, 0);
                
                convertedSlots.push({
                  id: slot.id,
                  slotStartTimeInUTC: slotDate.toISOString(),
                  slotEndTimeInUTC: new Date(slotDate.getTime() + duration).toISOString()
                });

                // Move to next week
                currentDate.setDate(currentDate.getDate() + 7);
              }
            });
            availableSlots = convertedSlots;
          }
        } else {
          console.error('Failed to fetch availability');
        }

        // Handle appointments
        let existingAppointments: Slot[] = [];
        if (appointmentsRes.ok) {
          const appointmentsData = await appointmentsRes.json();
          existingAppointments = appointmentsData.data;
        } else {
          console.error('Failed to fetch appointments:', await appointmentsRes.text());
        }

        // Handle consultant data
        if (consultantRes.ok) {
          const consultantData = await consultantRes.json();
          setConsultantData({
            scheduleType: consultantData.scheduleType || 'WEEKLY',
            timezone: consultantData.user?.currentTimezone || 'UTC'
          });
        } else {
          console.error('Failed to fetch consultant data:', await consultantRes.text());
        }

        // Update state
        setRequests(filteredRequests);
        setAvailableSlots(availableSlots);
        setExistingAppointments(existingAppointments);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    // Set up polling for real-time updates
    const REQUEST_POLL_INTERVAL = parseInt(process.env.NEXT_PUBLIC_REQUEST_POLL_INTERVAL ?? '300000'); // 5 minutes
    const interval = setInterval(fetchData, REQUEST_POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [consultantId, type]);

  const handleSlotSelect = (slot: string) => {
    setSelectedSlots(prevSlots => {
      if (prevSlots.includes(slot)) {
        return prevSlots.filter(s => s !== slot);
      } else if (selectedRequest && prevSlots.length < selectedRequest.requiredSlots) {
        return [...prevSlots, slot].sort();
      }
      return prevSlots;
    });
  };

  const handleAllocation = async (isAuto: boolean, useRequestedSlots: boolean = false) => {
    if (!selectedRequest) return;
    if (!isAuto && !useRequestedSlots && selectedSlots.length !== selectedRequest.requiredSlots) return;

    try {
      const endpoint = selectedRequest.type === AppointmentsType.SUBSCRIPTION
        ? `/api/events/subscriptions/${selectedRequest.id}/allocate`
        : `/api/events/consultations/${selectedRequest.id}/allocate`;

      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          isAuto,
          useRequestedSlots,
          ...(isAuto || useRequestedSlots ? {} : { slots: selectedSlots }),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to allocate slots');
      }

      // Success handling
      toast({
        title: "Success",
        description: `Slots have been ${useRequestedSlots ? 'allocated as requested' : isAuto ? 'automatically allocated' : 'allocated'}`,
        variant: "default", // green toast
      });

      // Close dialog and reset state
      setDialogOpen(false);
      setSelectedRequest(null);
      setSelectedSlots([]);

      // Remove request from list
      setRequests(prev => prev.filter(r => r.id !== selectedRequest.id));

      // Notify parent
      onUpdate();
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to allocate slots",
        variant: "destructive", // red toast
      });
    }
  };

  const handleAutoAllocate = async () => {
    if (isAllocating) return;
    setIsAllocating(true);
    try {
      await handleAllocation(true);
    } finally {
      setIsAllocating(false);
    }
  };

  const handleManualAllocate = async () => {
    if (isAllocating) return;
    setIsAllocating(true);
    try {
      await handleAllocation(false);
    } finally {
      setIsAllocating(false);
    }
  };

  const handleRequestedAllocate = async (request: Request) => {
    if (isAllocating) return;
    setIsAllocating(true);
    try {
      setSelectedRequest(request);
      await handleAllocation(false, true);
    } finally {
      setIsAllocating(false);
    }
  };

  // Check if auto-allocation is possible
  const canAutoAllocate = selectedRequest?.requiredSlots && 
    availableSlots.filter(slot => !existingAppointments.some(existing => 
      existing.slotStartTimeInUTC === slot.slotStartTimeInUTC
    )).length >= selectedRequest.requiredSlots;

  // Check if manual allocation quota is met
  const isQuotaMet = selectedRequest?.requiredSlots === selectedSlots.length;

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Slot Allocation</CardTitle>
          <CardDescription>Loading requests and availability...</CardDescription>
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
          <Button onClick={() => window.location.reload()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Slot Allocation</CardTitle>
        <CardDescription>Allocate slots for subscription and class requests</CardDescription>
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
                <TableCell>{new Date(request.requestedAt).toLocaleString()}</TableCell>
                <TableCell>
                  {request.requestedTimes && request.requestedTimes.length > 0 ? (
                    request.requestedTimes.map((time, index) => (
                      <div key={index} className="text-sm">
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
                    variant={request.status === RequestStatus.PENDING ? 'outline' : 
                             request.status === RequestStatus.APPROVED ? 'default' : 'destructive'}
                  >
                    {request.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {request.status === RequestStatus.PENDING && (
                    <>
                      {request.requestedTimes && request.requestedTimes.length > 0 && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="mr-2"
                          onClick={() => handleRequestedAllocate(request)}
                          disabled={isAllocating}
                        >
                          {isAllocating ? 'Allocating...' : 'Use Requested Times'}
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
                        <DialogContent className="max-w-3xl" onInteractOutside={(e) => {
                          // Prevent closing dialog while allocating
                          if (isAllocating) {
                            e.preventDefault();
                          }
                        }}>
                          <DialogHeader>
                            <DialogTitle>Allocate Slots</DialogTitle>
                            <DialogDescription>
                              Choose {request.requiredSlots} slots for {request.type.toLowerCase()}
                            </DialogDescription>
                          </DialogHeader>
                          <Calendar
                            availableSlots={availableSlots.map(slot => slot.slotStartTimeInUTC)}
                            existingAppointments={existingAppointments.map(slot => slot.slotStartTimeInUTC)}
                            onSlotSelect={handleSlotSelect}
                            selectedSlots={selectedSlots}
                            requiredSlots={request.requiredSlots}
                            scheduleType={consultantData.scheduleType}
                            consultantTimezone={consultantData.timezone}
                          />
                          <DialogFooter>
                            <Button 
                              variant="outline" 
                              onClick={handleAutoAllocate} 
                              disabled={!canAutoAllocate || isAllocating}
                            >
                              {isAllocating ? 'Allocating...' : 'Auto Allocate'}
                            </Button>
                            <Button 
                              onClick={handleManualAllocate} 
                              disabled={!isQuotaMet || isAllocating}
                            >
                              {isAllocating ? 'Allocating...' : 'Allocate Manual Slots'}
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </>
                  )}
                  {request.status === RequestStatus.APPROVED && request.allocatedSlots && (
                    <div className="text-sm text-muted-foreground">
                      {request.allocatedSlots.length} slots allocated
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
