"use client"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { addDays, format, isSameDay, startOfWeek } from "date-fns"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useParams } from "next/navigation"
import React, { useEffect, useState } from "react"
import { AppointmentsType } from "@prisma/client"
import { Appointment, AppointmentSlot, TimeSlot } from "../types/calendar"
import { mapCustomSlots, mapWeeklySlots } from "../utils"

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

interface TimingsCalendarProps {
  isOpen: boolean
  onClose: () => void
  eventType: "webinar" | "class"
  eventId: string
  callsPerWeek?: number
  durationInMonths?: number
}

export function TimingsCalendar({
  isOpen,
  onClose,
  eventType,
  eventId,
  callsPerWeek = 1,
  durationInMonths = 1
}: TimingsCalendarProps) {
  const params = useParams()
  const { toast } = useToast()
  const [currentDate, setCurrentDate] = useState(new Date())
  const [view, setView] = useState<"week" | "month">("week")
  const [availableSlots, setAvailableSlots] = useState<TimeSlot[]>([])
  const [existingAppointments, setExistingAppointments] = useState<TimeSlot[]>([])
  const [selectedSlots, setSelectedSlots] = useState<TimeSlot[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [scheduleType, setScheduleType] = useState<"WEEKLY" | "CUSTOM" | null>(null)
  const [browserTimezone] = useState(() => 
    typeof window !== "undefined" 
      ? Intl.DateTimeFormat().resolvedOptions().timeZone 
      : "UTC"
  )

  const startDate = startOfWeek(currentDate)
  const weekDates = [...Array(7)].map((_, i) => addDays(startDate, i))

  const fetchEventSlots = async () => {
    try {
      const params = new URLSearchParams({
        type: eventType.toUpperCase()
      })
      
      if (eventType === "webinar") {
        params.append("webinarId", eventId)
      } else {
        params.append("classId", eventId)
      }

      const response = await fetch(`/api/slots/appointments?${params}`)

      if (response.ok) {
        const { data } = await response.json()
        if (data && data.length > 0 && data[0].slotsOfAppointment?.length > 0) {
          const slots = data[0].slotsOfAppointment.map((slot: AppointmentSlot) => ({
            startTime: new Date(slot.slotStartTimeInUTC),
            endTime: new Date(slot.slotEndTimeInUTC),
            isAvailable: true,
            isBooked: false,
            originalSlot: slot
          }))
          setSelectedSlots(slots)
          
          // Set current date to the first slot's date
          setCurrentDate(new Date(slots[0].startTime))
        }
      }
    } catch (error) {
      console.error("Error fetching event slots:", error)
    }
  }

  const fetchData = async () => {
    try {
      if (!params.consultantId) {
        throw new Error("Consultant ID is required")
      }

      setLoading(true)

      const consultantId = params.consultantId.toString()
      const searchParams = new URLSearchParams()
      
      searchParams.append("consultantProfileId", consultantId)
      searchParams.append("type", eventType.toUpperCase())

      if (eventType === "webinar") {
        searchParams.append("webinarStatus", "APPROVED")
      } else {
        searchParams.append("classStatus", "APPROVED")
      }

      const [consultantResponse, appointmentsResponse] = await Promise.all([
        fetch(`/api/user/consultants/${consultantId}`),
        fetch(`/api/slots/appointments?${searchParams}`)
      ])

      // Handle consultant data
      if (consultantResponse.ok) {
        const { data: consultantData } = await consultantResponse.json()
        if (!consultantData) {
          throw new Error("Consultant not found")
        }

        setScheduleType(consultantData.scheduleType)

        // Map slots based on schedule type
        if (consultantData.scheduleType === "WEEKLY") {
          const slots = mapWeeklySlots(consultantData, currentDate, view)
          setAvailableSlots(slots)
        } else if (consultantData.scheduleType === "CUSTOM") {
          const slots = mapCustomSlots(consultantData)
          setAvailableSlots(slots)
        } else {
          toast({
            variant: "destructive",
            title: "No availability slots",
            description: "Please set up your availability slots first"
          })
        }
      }

      // Handle appointments data
      if (appointmentsResponse.ok) {
        const appointmentsData = await appointmentsResponse.json()
        const rawAppointments = appointmentsData.data || []
        
        const bookedSlots = rawAppointments
          .filter((appointment: Appointment) => {
            const slots = appointment.slotsOfAppointment || []
            const isCorrectType = appointment.appointmentType === eventType.toUpperCase()
            const isScheduled = eventType === "webinar" 
              ? appointment.webinar?.status === "SCHEDULED"
              : eventType === "class" 
                ? appointment.class?.status === "SCHEDULED"
                : true

            return slots.length > 0 && isCorrectType && isScheduled
          })
          .flatMap((appointment: Appointment) => {
            const slots = appointment.slotsOfAppointment || []
            return slots.map((slot: AppointmentSlot) => ({
              startTime: new Date(slot.slotStartTimeInUTC),
              endTime: new Date(slot.slotEndTimeInUTC),
              isAvailable: false,
              isBooked: true
            }))
          })
        setExistingAppointments(bookedSlots)
      }
    } catch (error) {
      console.error("Error fetching data:", error)
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to fetch available slots"
      })
    } finally {
      setLoading(false)
    }
  }

  // Fetch event slots and data when dialog opens
  useEffect(() => {
    if (isOpen) {
      fetchEventSlots()
      fetchData()
    } else {
      // Reset state when dialog closes
      setSelectedSlots([])
      setCurrentDate(new Date())
    }
  }, [isOpen])

  // Fetch data when date, schedule type, or view changes
  useEffect(() => {
    if (isOpen && scheduleType) {
      fetchData()
    }
  }, [currentDate, scheduleType, view])

  const handleSlotSelect = (hour: number, date: Date) => {
    const slotStart = new Date(date)
    slotStart.setHours(hour, 0, 0, 0)
    const slotEnd = new Date(slotStart)
    slotEnd.setHours(hour + 1, 0, 0, 0)

    // Get all slots for this hour
    const hourSlots = availableSlots.filter(slot => 
      isSameDay(slot.startTime, slotStart) && 
      slot.startTime.getHours() === hour
    )

    const bookedHourSlots = existingAppointments.filter(slot => 
      isSameDay(slot.startTime, slotStart) && 
      slot.startTime.getHours() === hour
    )

    // Apply overlap rules
    const isAvailable = hourSlots.some(availableSlot => {
      // Check for any type of overlap with booked slots
      const hasOverlap = bookedHourSlots.some(bookedSlot => {
        // Case 1: Available fully overlapped by Booked
        const availableFullyOverlapped = 
          availableSlot.startTime >= bookedSlot.startTime && 
          availableSlot.endTime <= bookedSlot.endTime

        // Case 2: Booked fully overlapped by Available
        const bookedFullyOverlapped = 
          bookedSlot.startTime >= availableSlot.startTime && 
          bookedSlot.endTime <= availableSlot.endTime

        // Case 3: Partial overlap
        const partialOverlap = 
          (availableSlot.startTime < bookedSlot.endTime && availableSlot.endTime > bookedSlot.startTime) ||
          (bookedSlot.startTime < availableSlot.endTime && bookedSlot.endTime > availableSlot.startTime)

        return availableFullyOverlapped || bookedFullyOverlapped || partialOverlap
      })

      // Case 4: No overlap - show the available slot
      return !hasOverlap
    })

    const isBooked = bookedHourSlots.length > 0

    if (!isAvailable || isBooked) return

    const newSlot = { startTime: slotStart, endTime: slotEnd, isAvailable: true, isBooked: false }

    // For webinars, only allow one slot
    if (eventType === "webinar") {
      setSelectedSlots([newSlot])
      return
    }

    // For classes, allow multiple slots
    const isSelected = selectedSlots.some(slot => 
      isSameDay(slot.startTime, slotStart) && 
      slot.startTime.getHours() === hour
    )

    if (isSelected) {
      setSelectedSlots(selectedSlots.filter(slot => 
        !isSameDay(slot.startTime, slotStart) || 
        slot.startTime.getHours() !== hour
      ))
    } else {
      const requiredSlots = callsPerWeek * 4 * durationInMonths
      if (eventType === "class" && selectedSlots.length >= requiredSlots) {
        toast({
          variant: "destructive",
          title: "Maximum slots reached",
          description: `You can only select ${requiredSlots} slots for this class (${callsPerWeek} calls/week × 4 weeks × ${durationInMonths} months)`
        })
        return
      }
      setSelectedSlots([...selectedSlots, newSlot])
    }
  }

  const handleSave = async () => {
    try {
      setSaving(true)

      // First, fetch existing appointments for this event
      const params = new URLSearchParams({
        type: eventType.toUpperCase()
      })
      
      if (eventType === "webinar") {
        params.append("webinarId", eventId)
      } else {
        params.append("classId", eventId)
      }

      const existingResponse = await fetch(`/api/slots/appointments?${params}`)

      if (existingResponse.ok) {
        const { data } = await existingResponse.json()
        const existingAppointment = data?.[0]

        let response
        // If there's an existing appointment, update it
        if (existingAppointment) {
          response = await fetch(`/api/slots/appointments/${existingAppointment.id}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              slotsOfAppointment: {
                deleteMany: {},
                createMany: {
                  data: selectedSlots.map(slot => ({
                    slotStartTimeInUTC: slot.originalSlot?.slotStartTimeInUTC || slot.startTime.toISOString(),
                    slotEndTimeInUTC: slot.originalSlot?.slotEndTimeInUTC || slot.endTime.toISOString(),
                  }))
                }
              }
            })
          })
        } else {
          // Create new appointment if none exists
          response = await fetch(`/api/slots/appointments`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              appointmentType: eventType.toUpperCase() as AppointmentsType,
              [eventType]: { connect: { id: eventId } },
              slotsOfAppointment: {
                create: selectedSlots.map(slot => ({
                  slotStartTimeInUTC: slot.originalSlot?.slotStartTimeInUTC || slot.startTime,
                  slotEndTimeInUTC: slot.originalSlot?.slotEndTimeInUTC || slot.endTime,
                }))
              }
            })
          })
        }

        if (!response.ok) {
          throw new Error('Failed to save timings')
        }
      }
      
      toast({
        title: "Success",
        description: "Timings saved successfully"
      })
      onClose()
    } catch (error) {
      console.error('Error saving timings:', error)
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save timings"
      })
    } finally {
      setSaving(false)
    }
  }

  const navigatePrevious = () => {
    if (view === "week") {
      setCurrentDate(new Date(currentDate.setDate(currentDate.getDate() - 7)))
    } else {
      setCurrentDate(new Date(currentDate.setMonth(currentDate.getMonth() - 1)))
    }
  }

  const navigateNext = () => {
    if (view === "week") {
      setCurrentDate(new Date(currentDate.setDate(currentDate.getDate() + 7)))
    } else {
      setCurrentDate(new Date(currentDate.setMonth(currentDate.getMonth() + 1)))
    }
  }

  const renderTimeCell = (hour: number, date: Date) => {
    const slotStart = new Date(date)
    slotStart.setHours(hour, 0, 0, 0)

    // Get all slots for this hour
    const hourSlots = availableSlots.filter(slot => 
      isSameDay(slot.startTime, slotStart) && 
      slot.startTime.getHours() === hour
    )

    const bookedHourSlots = existingAppointments.filter(slot => 
      isSameDay(slot.startTime, slotStart) && 
      slot.startTime.getHours() === hour
    )

    // Apply overlap rules
    const isAvailable = hourSlots.some(availableSlot => {
      // Check for any type of overlap with booked slots
      const hasOverlap = bookedHourSlots.some(bookedSlot => {
        // Case 1: Available fully overlapped by Booked
        const availableFullyOverlapped = 
          availableSlot.startTime >= bookedSlot.startTime && 
          availableSlot.endTime <= bookedSlot.endTime

        // Case 2: Booked fully overlapped by Available
        const bookedFullyOverlapped = 
          bookedSlot.startTime >= availableSlot.startTime && 
          bookedSlot.endTime <= availableSlot.endTime

        // Case 3: Partial overlap
        const partialOverlap = 
          (availableSlot.startTime < bookedSlot.endTime && availableSlot.endTime > bookedSlot.startTime) ||
          (bookedSlot.startTime < availableSlot.endTime && bookedSlot.endTime > availableSlot.startTime)

        return availableFullyOverlapped || bookedFullyOverlapped || partialOverlap
      })

      // Case 4: No overlap - show the available slot
      return !hasOverlap
    })

    const isBooked = bookedHourSlots.length > 0

    const isSelected = selectedSlots.some(slot => 
      isSameDay(slot.startTime, slotStart) && 
      slot.startTime.getHours() === hour
    )

    const now = new Date()
    const isInPast = slotStart < now

    return (
      <Button
        key={`${date.toISOString()}-${hour}`}
        variant={isSelected ? "default" : isAvailable ? "outline" : "ghost"}
        className={`h-12 w-full relative
          ${isBooked ? "bg-gray-200 hover:bg-gray-200" : ""}
          ${isInPast ? "opacity-50" : ""}
        `}
        onClick={() => !isInPast && handleSlotSelect(hour, date)}
        disabled={!isAvailable || isBooked || isInPast}
      >
        {isBooked ? "Booked" : isSelected ? "Selected" : isAvailable ? "Available" : ""}
      </Button>
    )
  }

  if (loading || !scheduleType) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {loading 
                ? "Loading your calendar..." 
                : "Schedule type not configured"}
            </DialogTitle>
            <DialogDescription>
              {loading 
                ? "Please wait while we fetch your calendar data..."
                : "Please set up your availability in the settings before managing event timings."}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-7xl">
        <DialogHeader>
          <DialogTitle>
            Manage {eventType === "webinar" ? "Webinar" : "Class"} Timings
          </DialogTitle>
          <DialogDescription>
            {eventType === "webinar" 
              ? "Select one time slot for your webinar."
              : `Select ${callsPerWeek * 4 * durationInMonths} time slots for your class (${callsPerWeek} calls/week × 4 weeks × ${durationInMonths} months).`
            }
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex justify-between items-center gap-4">
            <div className="flex gap-2">
              <Button
                variant={view === "week" ? "default" : "outline"}
                size="sm"
                onClick={() => setView("week")}
              >
                Week
              </Button>
              <Button
                variant={view === "month" ? "default" : "outline"}
                size="sm"
                onClick={() => setView("month")}
              >
                Month
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={navigatePrevious}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="text-lg font-bold">
              {format(currentDate, "MMMM yyyy")}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={navigateNext}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {view === "week" ? (
            <>
              <div className="grid grid-cols-8 gap-1">
                <div className="w-20"></div>
                {weekDates.map((date, i) => (
                  <div key={i} className="text-center">
                    <div className="font-bold">{DAYS[i]}</div>
                    <div className="text-sm text-muted-foreground">
                      {format(date, "d")}
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-8 gap-1 h-[600px] overflow-y-auto">
                {HOURS.map(hour => (
                  <React.Fragment key={hour}>
                    <div className="w-20 text-right pr-2 py-2 text-sm sticky left-0 bg-background z-10">
                      {hour.toString().padStart(2, "0")}:00
                    </div>
                    {weekDates.map((date, i) => (
                      <div key={i}>
                        {renderTimeCell(hour, date)}
                      </div>
                    ))}
                  </React.Fragment>
                ))}
              </div>
            </>
          ) : (
            <div className="grid grid-cols-7 gap-1 h-[600px] overflow-y-auto">
              {DAYS.map(day => (
                <div key={day} className="text-center font-bold">
                  {day}
                </div>
              ))}
              {/* Empty cells for days before the first of the month */}
              {Array.from({ length: new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).getDay() }, (_, i) => (
                <div key={`empty-start-${i}`} className="min-h-[100px] border p-2 bg-gray-50/50" />
              ))}

              {/* Days of the month */}
              {Array.from({ length: new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate() }, (_, i) => {
                const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), i + 1)
                const daySlots = availableSlots.filter(slot => isSameDay(slot.startTime, date))
                const bookedSlots = existingAppointments.filter(slot => isSameDay(slot.startTime, date))
                const selectedDaySlots = selectedSlots.filter(slot => isSameDay(slot.startTime, date))

                // Filter slots based on overlap rules
                const displaySlots = daySlots.filter(availableSlot => {
                  // Check for any type of overlap with booked slots
                  const overlappingBookedSlots = bookedSlots.filter(bookedSlot => {
                    const availableStart = availableSlot.startTime
                    const availableEnd = availableSlot.endTime
                    const bookedStart = bookedSlot.startTime
                    const bookedEnd = bookedSlot.endTime

                    // Case 1: Available fully overlapped by Booked
                    const availableFullyOverlapped = 
                      availableStart >= bookedStart && availableEnd <= bookedEnd

                    // Case 2: Booked fully overlapped by Available
                    const bookedFullyOverlapped = 
                      bookedStart >= availableStart && bookedEnd <= availableEnd

                    // Case 3: Partial overlap
                    const partialOverlap = 
                      (availableStart < bookedEnd && availableEnd > bookedStart) ||
                      (bookedStart < availableEnd && bookedEnd > availableStart)

                    return availableFullyOverlapped || bookedFullyOverlapped || partialOverlap
                  })

                  // Case 4: No overlap - show the available slot
                  return overlappingBookedSlots.length === 0
                })

                return (
                  <div key={i} className={`min-h-[100px] border p-2 ${
                    isSameDay(date, new Date()) ? "ring-2 ring-primary" : ""
                  }`}>
                    <div className={`font-bold mb-1 ${
                      isSameDay(date, new Date()) ? "text-primary" : ""
                    }`}>{i + 1}</div>
                    <div className="space-y-1 overflow-y-auto max-h-[80px] scrollbar-thin">
                      {bookedSlots.map((slot, j) => (
                        <div key={j} className="text-xs bg-gray-200 p-1 rounded">
                          {format(slot.startTime, "HH:mm")} - Booked
                        </div>
                      ))}
                      {displaySlots.map((slot, j) => (
                        <Button
                          key={j}
                          variant={selectedDaySlots.some(s => 
                            s.startTime.getTime() === slot.startTime.getTime()
                          ) ? "default" : "outline"}
                          size="sm"
                          className="w-full text-xs justify-start"
                          onClick={() => handleSlotSelect(
                            slot.startTime.getHours(),
                            slot.startTime
                          )}
                        >
                          {format(slot.startTime, "HH:mm")}
                        </Button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="flex justify-between items-center">
            <div className="text-sm">
              Selected: {selectedSlots.length} / {
                eventType === "webinar" 
                  ? "1" 
                  : `${callsPerWeek * 4 * durationInMonths}`
              } slots
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button 
                onClick={handleSave}
                disabled={
                  selectedSlots.length === 0 || 
                  saving || 
                  (eventType === "class" && selectedSlots.length !== callsPerWeek * 4 * durationInMonths)
                }
              >
                {saving ? "Saving..." : "Save Timings"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
