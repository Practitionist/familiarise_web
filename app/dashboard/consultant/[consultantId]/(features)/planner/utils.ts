import { startOfWeek, addDays } from "date-fns"
import { DayOfWeek } from "@prisma/client"
import { TWeeklySlot } from "@/types/slots"
import { ConsultantData, TimeSlot } from "./types/calendar"

const DAY_INDEX: Record<DayOfWeek, number> = {
  'SUNDAY': 0,
  'MONDAY': 1,
  'TUESDAY': 2,
  'WEDNESDAY': 3,
  'THURSDAY': 4,
  'FRIDAY': 5,
  'SATURDAY': 6
}

export function mapWeeklySlots(consultantData: ConsultantData, currentDate: Date, view: "week" | "month" = "week"): TimeSlot[] {
  if (consultantData.scheduleType !== "WEEKLY" || !consultantData.slotsOfAvailabilityWeekly?.length) {
    return []
  }

  // Get the start and end dates based on view
  let startDate: Date, endDate: Date
  if (view === "week") {
    startDate = startOfWeek(currentDate)
    endDate = new Date(startDate)
    endDate.setDate(startDate.getDate() + 6)
  } else {
    const year = currentDate.getFullYear()
    const month = currentDate.getMonth()
    startDate = new Date(year, month, 1)
    endDate = new Date(year, month + 1, 0)
  }

  window.console.log('Date range:', {
    view,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString()
  })

  // Create slots for each weekly pattern within the date range
  const slots: TimeSlot[] = []
  let iterDate = new Date(startDate)

  while (iterDate <= endDate) {
    const dayOfWeek = iterDate.getDay()
    window.console.log('Processing date:', {
      date: iterDate.toISOString(),
      dayOfWeek
    })

    const matchingSlots = consultantData.slotsOfAvailabilityWeekly.filter(
      slot => DAY_INDEX[slot.dayOfWeekforStartTimeInUTC] === dayOfWeek
    )
    window.console.log('Matching slots:', matchingSlots)

    matchingSlots.forEach(slot => {
      const startTime = new Date(slot.slotStartTimeInUTC)
      const endTime = new Date(slot.slotEndTimeInUTC)
      window.console.log('Original slot times:', {
        start: startTime.toISOString(),
        end: endTime.toISOString()
      })

      // Create a new date with current date and slot's time
      const slotStartTime = new Date(iterDate)
      slotStartTime.setHours(startTime.getHours(), startTime.getMinutes(), 0, 0)
      
      const slotEndTime = new Date(iterDate)
      slotEndTime.setHours(endTime.getHours(), endTime.getMinutes(), 0, 0)

      window.console.log('Mapped slot times:', {
        start: slotStartTime.toISOString(),
        end: slotEndTime.toISOString()
      })

      // Handle slots that cross midnight
      if (slotEndTime <= slotStartTime) {
        slotEndTime.setDate(slotEndTime.getDate() + 1)
      }

      // Create hourly slots
      let currentHour = new Date(slotStartTime)
      window.console.log('Creating hourly slots starting from:', currentHour.toISOString())

      while (currentHour < slotEndTime) {
        const nextHour = new Date(currentHour)
        nextHour.setHours(currentHour.getHours() + 1)
        
        const endTimeForSlot = nextHour > slotEndTime ? slotEndTime : nextHour
        window.console.log('Creating slot:', {
          start: currentHour.toISOString(),
          end: endTimeForSlot.toISOString()
        })
        
        slots.push({
          startTime: new Date(currentHour),
          endTime: new Date(endTimeForSlot),
          isAvailable: true,
          isBooked: false,
          originalSlot: slot
        })
        
        currentHour = nextHour
      }
    })

    iterDate.setDate(iterDate.getDate() + 1)
  }

  return slots
}

export function mapCustomSlots(consultantData: ConsultantData): TimeSlot[] {
  if (consultantData.scheduleType !== "CUSTOM" || !consultantData.slotsOfAvailabilityCustom?.length) {
    return []
  }

  return consultantData.slotsOfAvailabilityCustom.map(slot => ({
    startTime: new Date(slot.slotStartTimeInUTC),
    endTime: new Date(slot.slotEndTimeInUTC),
    isAvailable: true,
    isBooked: false,
    originalSlot: slot
  }))
}
