"use client"

import React, { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useParams } from "next/navigation"
import { useToast } from "@/components/ui/use-toast"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { format, startOfWeek, addDays, isSameDay } from "date-fns"

interface TimingsCalendarProps {
  isOpen: boolean
  onClose: () => void
  eventType: "webinar" | "class"
  eventId: string
}

import { TSlotTiming } from "@/types/slots"

interface TimeSlot {
  startTime: Date
  endTime: Date
  isAvailable: boolean
  isBooked: boolean
  originalSlot?: TSlotTiming
}

interface AppointmentSlot {
  slotStartTimeInUTC: string | Date
  slotEndTimeInUTC: string | Date
}

interface Appointment {
  id: string
  appointmentType: string
  slotsOfAppointment?: AppointmentSlot[]
  webinar?: { status: string }
  class?: { status: string }
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export function TimingsCalendar({
  isOpen,
  onClose,
  eventType,
  eventId,
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

  const fetchData = async () => {
    try {
      if (!params.consultantId) {
        throw new Error("Consultant ID is required")
      }

      setLoading(true)

      const consultantId = params.consultantId.toString()

      // Fetch consultant and appointments data in parallel
      const [consultantResponse, appointmentsResponse] = await Promise.all([
        fetch(`/api/user/consultants/${consultantId}`),
        fetch(
          `/api/slots/appointments?` + 
          new URLSearchParams({
            consultantProfileId: consultantId,
            type: eventType.toUpperCase(),
            ...(eventType === "webinar" ? { webinarStatus: "APPROVED" } : {}),
            ...(eventType === "class" ? { classStatus: "APPROVED" } : {})
          }).toString()
        )
      ])

      // Handle consultant data
      if (consultantResponse.ok) {
        const { data: consultantData } = await consultantResponse.json()
        if (!consultantData) {
          throw new Error("Consultant not found")
        }

        setScheduleType(consultantData.scheduleType)

        // Map slots directly from consultant data
        if (consultantData.scheduleType === "WEEKLY" && consultantData.slotsOfAvailabilityWeekly?.length > 0) {
          const slots = consultantData.slotsOfAvailabilityWeekly.map((slot: any) => ({
            startTime: new Date(slot.slotStartTimeInUTC),
            endTime: new Date(slot.slotEndTimeInUTC),
            isAvailable: true,
            isBooked: false,
            originalSlot: slot
          }))
          setAvailableSlots(slots)
        } else if (consultantData.scheduleType === "CUSTOM" && consultantData.slotsOfAvailabilityCustom?.length > 0) {
          const slots = consultantData.slotsOfAvailabilityCustom.map((slot: any) => ({
            startTime: new Date(slot.slotStartTimeInUTC),
            endTime: new Date(slot.slotEndTimeInUTC),
            isAvailable: true,
            isBooked: false,
            originalSlot: slot
          }))
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
        // Log detailed appointments data to browser console
        window.console.group('Appointments Data')
        window.console.log('Raw Response:', appointmentsData)
        window.console.log('Event Type:', eventType.toUpperCase())
        window.console.log('Consultant ID:', params.consultantId)
        
        const rawAppointments = appointmentsData.data || []
        window.console.log('Total Appointments:', rawAppointments.length)
        
        // Log each appointment's details
        rawAppointments.forEach((appointment: Appointment, index: number) => {
          window.console.group(`Appointment ${index + 1}`)
          window.console.log('Type:', appointment.appointmentType)
          window.console.log('Status:', appointment.webinar?.status || appointment.class?.status)
          window.console.log('Slots:', appointment.slotsOfAppointment?.length || 0)
          window.console.log('Full Data:', appointment)
          window.console.groupEnd()
        })
        
        window.console.groupEnd()

        window.console.log('Filtering appointments:', rawAppointments.length)
        
        const bookedSlots = rawAppointments
          .filter((appointment: Appointment) => {
            const slots = appointment.slotsOfAppointment || []
            const isCorrectType = appointment.appointmentType === eventType.toUpperCase()
            const isScheduled = eventType === "webinar" 
              ? appointment.webinar?.status === "SCHEDULED"
              : eventType === "class" 
                ? appointment.class?.status === "SCHEDULED"
                : true

            const shouldInclude = slots.length > 0 && isCorrectType && isScheduled
            
            // Log filtering decision
            window.console.log('Appointment filtering:', {
              id: appointment.id,
              type: appointment.appointmentType,
              hasSlots: slots.length > 0,
              isCorrectType,
              isScheduled,
              included: shouldInclude
            })

            return shouldInclude
          })
          .flatMap((appointment: Appointment) => {
            const slots = appointment.slotsOfAppointment || []
            const mappedSlots = slots.map((slot: AppointmentSlot) => ({
              startTime: new Date(slot.slotStartTimeInUTC),
              endTime: new Date(slot.slotEndTimeInUTC),
              isAvailable: false,
              isBooked: true
            }))
            
            // Log mapped slots
            window.console.log('Mapped slots for appointment:', {
              id: appointment.id,
              originalSlots: slots,
              mappedSlots
            })
            
            return mappedSlots
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

  useEffect(() => {
    if (isOpen) {
      fetchData()
    }
  }, [isOpen, currentDate, scheduleType])

  const handleSlotSelect = (hour: number, date: Date) => {
    const slotStart = new Date(date)
    slotStart.setHours(hour, 0, 0, 0)
    const slotEnd = new Date(slotStart)
    slotEnd.setHours(hour + 1, 0, 0, 0)

    // Check if slot is available
    const isAvailable = availableSlots.some(slot => 
      isSameDay(slot.startTime, slotStart) && 
      slot.startTime.getHours() === hour
    )

    // Check if slot is booked
    const isBooked = existingAppointments.some(slot => 
      isSameDay(slot.startTime, slotStart) && 
      slot.startTime.getHours() === hour
    )

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
      setSelectedSlots([...selectedSlots, newSlot])
    }
  }

  const handleSave = async () => {
    try {
      setSaving(true)
      const response = await fetch(`/api/slots/appointments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          appointmentType: eventType.toUpperCase(),
          [eventType]: { connect: { id: eventId } },
          slotsOfAppointment: {
            createMany: {
              data: selectedSlots.map(slot => ({
                slotStartTimeInUTC: slot.originalSlot?.slotStartTimeInUTC || slot.startTime.toISOString(),
                slotEndTimeInUTC: slot.originalSlot?.slotEndTimeInUTC || slot.endTime.toISOString(),
              }))
            }
          }
        })
      })
      
      if (!response.ok) {
        throw new Error('Failed to save timings')
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

    const isAvailable = availableSlots.some(slot => 
      isSameDay(slot.startTime, slotStart) && 
      slot.startTime.getHours() === hour
    )

    const isBooked = existingAppointments.some(slot => 
      isSameDay(slot.startTime, slotStart) && 
      slot.startTime.getHours() === hour
    )

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
            Select available time slots for your {eventType === "webinar" ? "webinar" : "class"}. 
            {eventType === "webinar" ? " You can select one slot." : " You can select multiple slots."}
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

                // Apply overlap rules
                const displaySlots = daySlots.filter(availableSlot => {
                  const hasOverlap = bookedSlots.some(bookedSlot => {
                    const availableStart = availableSlot.startTime
                    const availableEnd = availableSlot.endTime
                    const bookedStart = bookedSlot.startTime
                    const bookedEnd = bookedSlot.endTime

                    // Check for any type of overlap
                    return (
                      (availableStart <= bookedEnd && availableEnd >= bookedStart) ||
                      (bookedStart <= availableEnd && bookedEnd >= availableStart)
                    )
                  })

                  // Only show available slot if there's no overlap
                  return !hasOverlap
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
              Selected: {selectedSlots.length} {eventType === "webinar" ? "/ 1" : "slots"}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button 
                onClick={handleSave}
                disabled={selectedSlots.length === 0 || saving}
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
