"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Gift,
  Calendar,
  Clock,
  User,
  CheckCircle,
  XCircle,
  Loader2,
  RefreshCw,
  Video,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";
import { getOrCreateAppointmentMeeting } from "@/lib/meeting";
import type { TAppointment } from "@/types/appointment";
import {
  TrialScheduleCalendar,
  SelectedSlot,
} from "./components/TrialScheduleCalendar";

interface TrialSession {
  id: string;
  status: string;
  notes: string | null;
  requestedAt: string;
  completedAt: string | null;
  consulteeProfile: {
    id: string;
    user: {
      id: string;
      name: string;
      email: string;
      image: string | null;
    };
  };
  subscriptionPlan: {
    id: string;
    title: string;
    freeTrialDurationMinutes: number;
  };
  appointment: {
    id: string;
    slotsOfAppointment: Array<{
      id: string;
      startsAt: string;
      endsAt: string;
    }>;
  } | null;
}

const statusColors: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  SCHEDULED: "bg-purple-100 text-purple-800",
  COMPLETED: "bg-green-100 text-green-800",
  CONVERTED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-gray-100 text-gray-800",
  REJECTED: "bg-red-100 text-red-800",
};

export function TrialsTab() {
  const params = useParams();
  const consultantId = params.consultantId as string;
  const { toast } = useToast();
  const router = useRouter();
  const client = useStreamVideoClient();

  const [trials, setTrials] = useState<TrialSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedTrial, setSelectedTrial] = useState<TrialSession | null>(null);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isJoining, setIsJoining] = useState<string | null>(null);

  const fetchTrials = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        consultantProfileId: consultantId,
      });
      if (statusFilter !== "all") {
        params.append("status", statusFilter);
      }

      const response = await fetch(`/api/trials?${params}`);
      if (!response.ok) {
        throw new Error("Failed to fetch trials");
      }

      const { data } = await response.json();
      setTrials(data);
    } catch (error) {
      console.error("Error fetching trials:", error);
      toast({
        title: "Error",
        description: "Failed to load trial requests",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [consultantId, statusFilter, toast]);

  useEffect(() => {
    fetchTrials();
  }, [fetchTrials]);

  const handleApprove = async (trial: TrialSession) => {
    setSelectedTrial(trial);
    setShowScheduleDialog(true);
  };

  const handleSlotSelected = async (slot: SelectedSlot) => {
    if (!selectedTrial) return;
    setIsProcessing(true);

    try {
      // Single API call: PENDING → SCHEDULED with slot data
      const response = await fetch(`/api/trials/${selectedTrial.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "SCHEDULED",
          slotData: {
            startsAt: slot.startsAt.toISOString(),
            endsAt: slot.endsAt.toISOString(),
            slotOfAvailabilityId: slot.slotOfAvailabilityId,
            slotType: slot.slotType,
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to schedule trial");
      }

      toast({
        title: "Success",
        description: "Trial session approved and scheduled",
      });

      setShowScheduleDialog(false);
      setSelectedTrial(null);
      fetchTrials();
    } catch (error) {
      console.error("Error scheduling trial:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to schedule trial",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReject = async (trialId: string) => {
    try {
      setIsProcessing(true);
      // Use PATCH to set status to REJECTED (consultant declining)
      const response = await fetch(`/api/trials/${trialId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "REJECTED" }),
      });

      if (!response.ok) {
        throw new Error("Failed to decline trial");
      }

      toast({
        title: "Success",
        description: "Trial request declined",
      });

      fetchTrials();
    } catch (error) {
      console.error("Error declining trial:", error);
      toast({
        title: "Error",
        description: "Failed to decline trial request",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancel = async (trialId: string) => {
    try {
      setIsProcessing(true);
      // Use DELETE for cancellation of scheduled trials
      const response = await fetch(`/api/trials/${trialId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to cancel trial");
      }

      toast({
        title: "Success",
        description: "Trial session cancelled",
      });

      fetchTrials();
    } catch (error) {
      console.error("Error cancelling trial:", error);
      toast({
        title: "Error",
        description: "Failed to cancel trial",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleComplete = async (trialId: string) => {
    try {
      setIsProcessing(true);
      const response = await fetch(`/api/trials/${trialId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "COMPLETED" }),
      });

      if (!response.ok) {
        throw new Error("Failed to mark trial as completed");
      }

      toast({
        title: "Success",
        description: "Trial session marked as completed",
      });

      fetchTrials();
    } catch (error) {
      console.error("Error completing trial:", error);
      toast({
        title: "Error",
        description: "Failed to complete trial",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  };

  // Check if a trial session is joinable (within 10 mins before start and before end time)
  const isTrialJoinable = (trial: TrialSession): boolean => {
    if (trial.status !== "SCHEDULED" || !trial.appointment?.slotsOfAppointment?.[0]) {
      return false;
    }

    const slot = trial.appointment.slotsOfAppointment[0];
    const now = new Date();
    const startTime = new Date(slot.startsAt);
    const endTime = new Date(slot.endsAt);
    const joinWindowStart = new Date(startTime.getTime() - 10 * 60 * 1000); // 10 mins before

    return now >= joinWindowStart && now <= endTime;
  };

  const handleJoinMeeting = async (trial: TrialSession) => {
    if (!client) {
      toast({
        title: "Not signed in",
        description: "Video client not initialized. Please sign in to join the meeting.",
        variant: "destructive",
      });
      return;
    }

    if (!trial.appointment?.slotsOfAppointment?.[0]) {
      toast({
        title: "Unable to join",
        description: "Meeting information is not available.",
        variant: "destructive",
      });
      return;
    }

    setIsJoining(trial.id);
    try {
      const slot = trial.appointment.slotsOfAppointment[0];
      // Create a minimal appointment object for the meeting helper
      const appointmentForMeeting = {
        id: trial.appointment.id,
        appointmentType: "TRIAL" as const,
        slotsOfAppointment: trial.appointment.slotsOfAppointment,
      } as unknown as TAppointment;

      const meetingId = await getOrCreateAppointmentMeeting(
        client,
        appointmentForMeeting,
        slot as any,
      );

      toast({
        title: "Joining meeting",
        description: "You will now be redirected to the meeting room.",
      });

      router.push(`/meetings/${meetingId}`);
    } catch (error) {
      console.error("Error joining meeting:", error);
      toast({
        title: "Error joining meeting",
        description: error instanceof Error ? error.message : "Unknown error occurred",
        variant: "destructive",
      });
      setIsJoining(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Free Trial Requests</h1>
          <p className="text-gray-600 mt-1">
            Manage trial session requests from potential subscribers
          </p>
        </div>
        <Button variant="outline" onClick={fetchTrials} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <div className="w-48">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="SCHEDULED">Scheduled</SelectItem>
              <SelectItem value="COMPLETED">Completed</SelectItem>
              <SelectItem value="CONVERTED">Converted</SelectItem>
              <SelectItem value="CANCELLED">Cancelled</SelectItem>
              <SelectItem value="REJECTED">Declined</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Trial Requests List */}
      {trials.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Gift className="h-12 w-12 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              No trial requests
            </h3>
            <p className="text-gray-600">
              {statusFilter !== "all"
                ? "No trial requests match the selected filter"
                : "You don't have any trial requests yet. Enable free trials on your subscription plans to start receiving requests."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {trials.map((trial) => (
            <Card key={trial.id} className="overflow-hidden">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    {trial.consulteeProfile.user.image ? (
                      <img
                        src={trial.consulteeProfile.user.image}
                        alt={trial.consulteeProfile.user.name}
                        className="h-10 w-10 rounded-full"
                      />
                    ) : (
                      <div className="h-10 w-10 bg-blue-100 rounded-full flex items-center justify-center">
                        <User className="h-5 w-5 text-blue-600" />
                      </div>
                    )}
                    <div>
                      <CardTitle className="text-base">
                        {trial.consulteeProfile.user.name}
                      </CardTitle>
                      <CardDescription>
                        {trial.consulteeProfile.user.email}
                      </CardDescription>
                    </div>
                  </div>
                  <Badge className={statusColors[trial.status] || "bg-gray-100"}>
                    {trial.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Gift className="h-4 w-4" />
                    <span>{trial.subscriptionPlan.title}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Clock className="h-4 w-4" />
                    <span>
                      {trial.subscriptionPlan.freeTrialDurationMinutes} min trial
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Calendar className="h-4 w-4" />
                    <span>Requested {formatDate(trial.requestedAt)}</span>
                  </div>
                </div>

                {trial.notes && (
                  <div className="bg-gray-50 rounded-lg p-3 mb-4">
                    <p className="text-sm text-gray-700">
                      <span className="font-medium">Notes: </span>
                      {trial.notes}
                    </p>
                  </div>
                )}

                {trial.appointment?.slotsOfAppointment?.[0] && (
                  <div className="bg-blue-50 rounded-lg p-3 mb-4">
                    <p className="text-sm text-blue-700">
                      <span className="font-medium">Scheduled: </span>
                      {formatDate(trial.appointment.slotsOfAppointment[0].startsAt)}{" "}
                      at {formatTime(trial.appointment.slotsOfAppointment[0].startsAt)}
                    </p>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex items-center gap-2 justify-end">
                  {trial.status === "PENDING" && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleReject(trial.id)}
                        disabled={isProcessing}
                      >
                        <XCircle className="h-4 w-4 mr-1" />
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleApprove(trial)}
                        disabled={isProcessing}
                      >
                        <CheckCircle className="h-4 w-4 mr-1" />
                        Approve & Schedule
                      </Button>
                    </>
                  )}
                  {trial.status === "SCHEDULED" && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCancel(trial.id)}
                        disabled={isProcessing || isJoining === trial.id}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleJoinMeeting(trial)}
                        disabled={isProcessing || isJoining === trial.id || !isTrialJoinable(trial)}
                        className={isTrialJoinable(trial) ? "bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200" : ""}
                      >
                        {isJoining === trial.id ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            Joining...
                          </>
                        ) : (
                          <>
                            <Video className="h-4 w-4 mr-1" />
                            Join Meeting
                          </>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleComplete(trial.id)}
                        disabled={isProcessing || isJoining === trial.id}
                      >
                        <CheckCircle className="h-4 w-4 mr-1" />
                        Mark Completed
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Schedule Dialog with Calendar */}
      <Dialog open={showScheduleDialog} onOpenChange={setShowScheduleDialog}>
        <DialogContent className="max-w-4xl">
          {selectedTrial && (
            <TrialScheduleCalendar
              consultantId={consultantId}
              trialDurationMinutes={
                selectedTrial.subscriptionPlan.freeTrialDurationMinutes
              }
              onSlotSelect={handleSlotSelected}
              onCancel={() => {
                setShowScheduleDialog(false);
                setSelectedTrial(null);
              }}
              isProcessing={isProcessing}
              consulteeUserName={selectedTrial.consulteeProfile.user.name}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
