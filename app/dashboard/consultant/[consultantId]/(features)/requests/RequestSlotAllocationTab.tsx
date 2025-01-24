import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Calendar } from './prototype/Calendar';
import { toast } from '@/components/ui/use-toast';
import { AppointmentsType, RequestStatus } from "@prisma/client";

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

  // Fetch requests, available slots, and existing appointments
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        // Fetch data in parallel
        const [consultationsRes, subscriptionsRes, availabilityRes, appointmentsRes] = await Promise.all([
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
          fetch(`/api/slots/appointments?consultantProfileId=${consultantId}`)
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
          availableSlots = availabilityRes.data;
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
    const interval = setInterval(fetchData, 30000); // Poll every 30 seconds

    return () => clearInterval(interval);
  }, [consultantId]);

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

  const handleAutoAllocate = async () => {
    if (!selectedRequest) return;

    setIsAllocating(true);
    try {
      const endpoint = selectedRequest.type === AppointmentsType.SUBSCRIPTION
        ? `/api/events/subscriptions/${selectedRequest.id}/allocate`
        : `/api/events/consultations/${selectedRequest.id}/allocate`;

      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isAuto: true }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to auto-allocate slots');
      }

      toast({
        title: "Success",
        description: "Slots have been automatically allocated",
      });
      onUpdate();
      setSelectedRequest(null);
      setSelectedSlots([]);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to auto-allocate slots",
        variant: "destructive",
      });
    } finally {
      setIsAllocating(false);
    }
  };

  const handleManualAllocate = async () => {
    if (!selectedRequest || selectedSlots.length !== selectedRequest.requiredSlots) return;

    setIsAllocating(true);
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
          isAuto: false,
          slots: selectedSlots,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to allocate slots');
      }

      toast({
        title: "Success",
        description: "Slots have been allocated",
      });
      onUpdate();
      setSelectedRequest(null);
      setSelectedSlots([]);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to allocate slots",
        variant: "destructive",
      });
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
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={() => {
                            setSelectedRequest(request);
                            setSelectedSlots([]);
                          }}
                        >
                          Allocate Slots
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-3xl">
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
