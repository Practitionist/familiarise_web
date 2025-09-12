"use client";

import React, { useState, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
// import { Slider } from "@/components/ui/slider"; // Not available, using custom implementation
import { Separator } from "@/components/ui/separator";
import {
  Sparkles,
  Clock,
  Calendar,
  Target,
  AlertCircle,
  CheckCircle,
} from "lucide-react";
import {
  AllocationAlgorithms,
  AutoAllocationPreferences,
  AllocationOptions,
  AllocationResult,
} from "../utils/allocationAlgorithms";
import { TimeSlot } from "../utils/calendarUtils";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

export interface AutoAllocationDemoProps {
  consultantId: string;
  availableSlots: TimeSlot[];
  onSlotSelected?: (slots: TimeSlot[]) => void;
  onDemoComplete?: (result: AllocationResult) => void;
}

// auto allocation alogirthm neeeds to be implemented
/**
 * AUTO ALLOCATION DEMO COMPONENT
 * ===============================
 *
 * INTERACTIVE DEMONSTRATION FEATURES:
 *
 * 1. REAL-TIME PREFERENCE FILTERING:
 *    - Shows how preferences filter available slots instantly
 *    - Visual feedback with slot counts and badges
 *    - Interactive preference toggles and sliders
 *
 * 2. MULTIPLE EVENT TYPE TESTING:
 *    - Consultation: Single slot allocation
 *    - Webinar: Multi-hour consecutive slot allocation
 *    - Subscription/Class: Distributed multi-slot allocation
 *
 * 3. STRATEGY VISUALIZATION:
 *    - Shows which allocation strategy was used
 *    - Success/error states with detailed feedback
 *    - Real-time filtering results display
 *
 * 4. COMPREHENSIVE CONFIGURATION:
 *    - Time preferences (morning, afternoon, evening)
 *    - Weekday/weekend preferences
 *    - Session duration and frequency settings
 *    - Minimum spacing between sessions
 */
export function AutoAllocationDemo({
  consultantId,
  availableSlots,
  onSlotSelected,
  onDemoComplete,
}: AutoAllocationDemoProps) {
  const { toast } = useToast();

  // DEMO CONFIGURATION STATE
  const [eventType, setEventType] = useState<
    "consultation" | "subscription" | "webinar" | "class"
  >("consultation");
  const [durationInMonths, setDurationInMonths] = useState(1);
  const [callsPerWeek, setCallsPerWeek] = useState(1);
  const [sessionDuration, setSessionDuration] = useState(1);
  const [consultationDuration, setConsultationDuration] = useState(1); // ADDED: Consultation duration

  // PREFERENCE SYSTEM STATE - Interactive configuration
  const [preferences, setPreferences] = useState<AutoAllocationPreferences>({
    preferWeekdays: true,
    preferMorning: false,
    preferAfternoon: true, // Default to afternoon preference
    preferEvening: false,
    excludeWeekends: false,
    minTimeBetweenSessions: 2, // 2 hours minimum spacing
  });

  // DEMO RESULTS STATE
  const [isAllocating, setIsAllocating] = useState(false);
  const [allocationResult, setAllocationResult] =
    useState<AllocationResult | null>(null);
  const [selectedSlots, setSelectedSlots] = useState<TimeSlot[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  /**
   * REAL-TIME PREFERENCE FILTERING
   * ===============================
   *
   * This demonstrates how preferences filter available slots in real-time.
   * Users can see immediate feedback on how their preferences affect slot availability.
   */
  const filteredSlots = useMemo(() => {
    const now = new Date();
    return availableSlots.filter((slot) => {
      // FILTER 1: Basic availability check
      if (slot.startTime <= now || !slot.isAvailable || slot.isBooked) {
        return false;
      }

      const hour = slot.startTime.getHours();
      const day = slot.startTime.getDay();

      // FILTER 2: Weekend exclusion
      if (preferences.excludeWeekends && (day === 0 || day === 6)) {
        return false;
      }

      // FILTER 3: Time preference filtering
      // Morning: 9 AM - 12 PM
      if (preferences.preferMorning && (hour < 9 || hour >= 12)) {
        return false;
      }
      // Afternoon: 1 PM - 5 PM
      if (preferences.preferAfternoon && (hour < 13 || hour >= 17)) {
        return false;
      }
      // Evening: 6 PM - 8 PM
      if (preferences.preferEvening && (hour < 18 || hour >= 20)) {
        return false;
      }

      return true;
    });
  }, [availableSlots, preferences]);

  /**
   * DYNAMIC SLOT REQUIREMENT CALCULATION
   * ====================================
   *
   * Calculates required slots based on event type and configuration.
   * This demonstrates different allocation strategies for different event types.
   */
  const requiredSlots = useMemo(() => {
    switch (eventType) {
      case "consultation":
        // FIXED: Use consultation duration instead of hardcoded value
        return Math.ceil(consultationDuration / 0.5); // 30-minute intervals
      case "webinar":
        return Math.ceil(sessionDuration * 2); // 30-minute intervals for multi-hour events
      case "subscription":
        // FIXED: Use actual subscription plan data instead of hardcoded calculations
        const totalSubscriptionCalls = durationInMonths * callsPerWeek; // Use actual duration and frequency
        const slotsPerSubscriptionCall = Math.ceil(sessionDuration / 0.5);
        return totalSubscriptionCalls * slotsPerSubscriptionCall;
      case "class":
        // FIXED: Use actual class plan data instead of hardcoded calculations
        const totalClassCalls = durationInMonths * callsPerWeek; // Use actual duration and frequency
        const slotsPerClassSession = Math.ceil(sessionDuration / 0.5);
        return totalClassCalls * slotsPerClassSession;
      default:
        return 1;
    }
  }, [
    eventType,
    durationInMonths,
    callsPerWeek,
    sessionDuration,
    consultationDuration,
  ]); // ADDED: consultationDuration dependency

  // PREFERENCE UPDATE HANDLER - Real-time preference changes
  const updatePreference = useCallback(
    (key: keyof AutoAllocationPreferences, value: any) => {
      setPreferences((prev) => ({
        ...prev,
        [key]: value,
      }));
    },
    [],
  );

  /**
   * AUTO ALLOCATION HANDLER
   * =======================
   *
   * Demonstrates the enhanced auto allocation system with:
   * - Preference validation
   * - Strategy selection based on event type
   * - Real-time feedback and error handling
   */
  const handleAutoAllocate = useCallback(async () => {
    // VALIDATION: Check if enough slots available after filtering
    if (filteredSlots.length < requiredSlots) {
      toast({
        variant: "destructive",
        title: "Not Enough Slots",
        description: `Need ${requiredSlots} slots but only ${filteredSlots.length} available after filtering.`,
      });
      return;
    }

    setIsAllocating(true);
    setAllocationResult(null);

    try {
      // CONFIGURATION: Prepare allocation options
      const options: AllocationOptions = {
        eventType,
        eventId: `demo-${Date.now()}`, // Demo ID for testing
        durationInMonths:
          eventType === "subscription" || eventType === "class"
            ? durationInMonths
            : undefined,
        callsPerWeek:
          eventType === "subscription" || eventType === "class"
            ? callsPerWeek
            : undefined,
        sessionDurationInHours:
          eventType === "webinar" ? sessionDuration : undefined,
        durationInHours:
          eventType === "consultation" ? consultationDuration : undefined, // FIXED: Add consultation duration
      };

      // EXECUTION: Run enhanced auto allocation with preferences
      const result = await AllocationAlgorithms.autoAllocate(
        availableSlots,
        options,
        preferences,
      );

      setAllocationResult(result);

      if (result.success) {
        setSelectedSlots(result.selectedSlots);
        onSlotSelected?.(result.selectedSlots);
        onDemoComplete?.(result);

        // SUCCESS FEEDBACK: Show strategy used and slots allocated
        toast({
          title: "Auto Allocation Successful! 🎉",
          description: `${result.selectedSlots.length} slots allocated using ${result.strategy} strategy.`,
        });
      } else {
        // ERROR FEEDBACK: Show specific error message
        toast({
          variant: "destructive",
          title: "Auto Allocation Failed",
          description: result.error || "Unknown error occurred.",
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Auto allocation failed";
      toast({
        variant: "destructive",
        title: "Error",
        description: errorMessage,
      });
    } finally {
      setIsAllocating(false);
    }
  }, [
    filteredSlots,
    requiredSlots,
    eventType,
    durationInMonths,
    callsPerWeek,
    sessionDuration,
    consultationDuration, // ADDED: Include consultation duration
    preferences,
    availableSlots,
    onSlotSelected,
    onDemoComplete,
    toast,
  ]);

  // DEMO RESET HANDLER - Reset to default state
  const handleReset = useCallback(() => {
    setAllocationResult(null);
    setSelectedSlots([]);
    setConsultationDuration(1); // ADDED: Reset consultation duration
    setPreferences({
      preferWeekdays: true,
      preferMorning: false,
      preferAfternoon: true,
      preferEvening: false,
      excludeWeekends: false,
      minTimeBetweenSessions: 2,
    });
  }, []);

  return (
    <div className="space-y-6">
      {/* DEMO HEADER - Introduction and overview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Auto Allocation Demo
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Test the enhanced auto allocation algorithms with different event
            types and preferences.
          </p>
        </CardHeader>
      </Card>

      {/* Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-4 w-4" />
            Event Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Event Type */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="event-type">Event Type</Label>
              <Select
                value={eventType}
                onValueChange={(value: any) => setEventType(value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select event type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="consultation">Consultation</SelectItem>
                  <SelectItem value="webinar">Webinar</SelectItem>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="class">Class</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Dynamic fields based on event type */}
            {eventType === "consultation" && (
              <div>
                <Label htmlFor="consultation-duration">
                  Consultation Duration (hours)
                </Label>
                <Select
                  value={consultationDuration.toString()}
                  onValueChange={(value) =>
                    setConsultationDuration(parseFloat(value))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0.5">30 minutes</SelectItem>
                    <SelectItem value="1">1 hour</SelectItem>
                    <SelectItem value="1.5">1.5 hours</SelectItem>
                    <SelectItem value="2">2 hours</SelectItem>
                    <SelectItem value="3">3 hours</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {eventType === "webinar" && (
              <div>
                <Label htmlFor="session-duration">
                  Session Duration (hours)
                </Label>
                <Select
                  value={sessionDuration.toString()}
                  onValueChange={(value) => setSessionDuration(parseInt(value))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0.5">30 minutes</SelectItem>
                    <SelectItem value="1">1 hour</SelectItem>
                    <SelectItem value="1.5">1.5 hours</SelectItem>
                    <SelectItem value="2">2 hours</SelectItem>
                    <SelectItem value="3">3 hours</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Subscription/Class specific fields */}
          {(eventType === "subscription" || eventType === "class") && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="duration">Duration (months)</Label>
                <Select
                  value={durationInMonths.toString()}
                  onValueChange={(value) =>
                    setDurationInMonths(parseInt(value))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 month</SelectItem>
                    <SelectItem value="2">2 months</SelectItem>
                    <SelectItem value="3">3 months</SelectItem>
                    <SelectItem value="6">6 months</SelectItem>
                    <SelectItem value="12">12 months</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="calls-per-week">Calls per week</Label>
                <Select
                  value={callsPerWeek.toString()}
                  onValueChange={(value) => setCallsPerWeek(parseInt(value))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 call/week</SelectItem>
                    <SelectItem value="2">2 calls/week</SelectItem>
                    <SelectItem value="3">3 calls/week</SelectItem>
                    <SelectItem value="4">4 calls/week</SelectItem>
                    <SelectItem value="5">5 calls/week</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Required slots calculation */}
          <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">
              <strong>Required slots:</strong> {requiredSlots}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Preferences */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Allocation Preferences
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? "Hide" : "Show"} Advanced Settings
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Basic preferences */}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="prefer-weekdays"
                checked={preferences.preferWeekdays}
                onCheckedChange={(checked) =>
                  updatePreference("preferWeekdays", checked)
                }
              />
              <Label htmlFor="prefer-weekdays">Prefer weekdays</Label>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="exclude-weekends"
                checked={preferences.excludeWeekends}
                onCheckedChange={(checked) =>
                  updatePreference("excludeWeekends", checked)
                }
              />
              <Label htmlFor="exclude-weekends">Exclude weekends</Label>
            </div>
          </div>

          {/* Time preferences */}
          <div className="space-y-3">
            <Label>Time Preferences</Label>
            <div className="grid grid-cols-3 gap-4">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="prefer-morning"
                  checked={preferences.preferMorning}
                  onCheckedChange={(checked) =>
                    updatePreference("preferMorning", checked)
                  }
                />
                <Label htmlFor="prefer-morning">Morning (9 AM - 12 PM)</Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="prefer-afternoon"
                  checked={preferences.preferAfternoon}
                  onCheckedChange={(checked) =>
                    updatePreference("preferAfternoon", checked)
                  }
                />
                <Label htmlFor="prefer-afternoon">
                  Afternoon (1 PM - 5 PM)
                </Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="prefer-evening"
                  checked={preferences.preferEvening}
                  onCheckedChange={(checked) =>
                    updatePreference("preferEvening", checked)
                  }
                />
                <Label htmlFor="prefer-evening">Evening (6 PM - 8 PM)</Label>
              </div>
            </div>
          </div>

          {/* Advanced settings */}
          {showAdvanced && (
            <>
              <Separator />
              <div className="space-y-3">
                <Label>Minimum time between sessions (hours)</Label>
                <div className="px-3">
                  <input
                    type="range"
                    value={preferences.minTimeBetweenSessions || 2}
                    onChange={(e) =>
                      updatePreference(
                        "minTimeBetweenSessions",
                        parseFloat(e.target.value),
                      )
                    }
                    max={8}
                    min={1}
                    step={0.5}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground mt-1">
                    <span>1 hour</span>
                    <span>{preferences.minTimeBetweenSessions || 2} hours</span>
                    <span>8 hours</span>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Stats */}
      <Card>
        <CardHeader>
          <CardTitle>Slot Availability</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">
                {availableSlots.length}
              </div>
              <div className="text-sm text-muted-foreground">
                Total Available
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">
                {filteredSlots.length}
              </div>
              <div className="text-sm text-muted-foreground">
                After Filtering
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">
                {requiredSlots}
              </div>
              <div className="text-sm text-muted-foreground">Required</div>
            </div>
          </div>

          {filteredSlots.length < requiredSlots && (
            <div className="flex items-center gap-2 mt-4 p-3 bg-destructive/10 rounded-lg">
              <AlertCircle className="h-4 w-4 text-destructive" />
              <span className="text-sm text-destructive">
                Not enough slots available after filtering. Consider adjusting
                your preferences.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-4">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={handleAutoAllocate}
                    disabled={
                      isAllocating ||
                      filteredSlots.length < requiredSlots ||
                      eventType === "class"
                    }
                    className="flex-1"
                  >
                    {isAllocating ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary-foreground border-t-transparent mr-2" />
                        Allocating...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4 mr-2" />
                        Auto Allocate
                      </>
                    )}
                  </Button>
                </TooltipTrigger>
                {eventType === "class" && (
                  <TooltipContent>
                    <p>Coming Soon!</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>

            <Button variant="outline" onClick={handleReset}>
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {allocationResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {allocationResult.success ? (
                <CheckCircle className="h-5 w-5 text-green-600" />
              ) : (
                <AlertCircle className="h-5 w-5 text-red-600" />
              )}
              Allocation Result
            </CardTitle>
          </CardHeader>
          <CardContent>
            {allocationResult.success ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">
                    Strategy: {allocationResult.strategy}
                  </Badge>
                  <Badge variant="outline">
                    {allocationResult.selectedSlots.length} slots selected
                  </Badge>
                </div>

                <div className="space-y-2">
                  <h4 className="font-medium">Selected Slots:</h4>
                  <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto">
                    {allocationResult.selectedSlots.map((slot, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between p-2 bg-muted/50 rounded"
                      >
                        <span className="text-sm">
                          {format(
                            slot.startTime,
                            "EEE, MMM d, yyyy 'at' h:mm a",
                          )}
                        </span>
                        <Badge variant="outline" className="text-xs">
                          {format(slot.startTime, "h:mm a")} -{" "}
                          {format(slot.endTime, "h:mm a")}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-destructive">
                  {allocationResult.error}
                </p>
                <p className="text-xs text-muted-foreground">
                  Try adjusting your preferences or event configuration.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
