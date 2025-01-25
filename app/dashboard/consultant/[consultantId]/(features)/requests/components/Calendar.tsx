import { Badge } from '@/components/ui/badge'
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ChevronLeft, ChevronRight } from 'lucide-react'
import React, { useState } from 'react'

type CalendarProps = {
  availableSlots: string[] | undefined
  existingAppointments: string[] | undefined
  onSlotSelect: (slot: string) => void
  selectedSlots: string[] | undefined
  requiredSlots: number
  scheduleType: 'WEEKLY' | 'CUSTOM'
  consultantTimezone: string
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = Array.from({ length: 24 }, (_, i) => i)

export function Calendar({ 
  availableSlots = [], 
  existingAppointments = [], 
  onSlotSelect, 
  selectedSlots = [], 
  requiredSlots,
  scheduleType,
  consultantTimezone
}: CalendarProps) {
  const [currentDate, setCurrentDate] = useState(new Date())
  const [view, setView] = useState<'week' | 'month'>('week')

  const navigatePrevious = () => {
    setCurrentDate(new Date(currentDate.setDate(currentDate.getDate() - (view === 'week' ? 7 : 30))))
  }

  const navigateNext = () => {
    setCurrentDate(new Date(currentDate.setDate(currentDate.getDate() + (view === 'week' ? 7 : 30))))
  }

  const getDaysInMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  }

  const renderTimeCell = (date: Date, hour: number) => {
    const slotDate = new Date(date)
    slotDate.setHours(hour, 0, 0, 0)
    const slotString = slotDate.toISOString()
    const isAvailable = availableSlots?.includes(slotString)
    const isExisting = existingAppointments?.includes(slotString)
    const isSelected = selectedSlots?.includes(slotString)
    const now = new Date()
    const isInPast = slotDate < now

    return (
      <Button
        key={`${date.toISOString()}-${hour}`}
        variant={isSelected ? "default" : isAvailable ? "outline" : "ghost"}
        className={`h-12 w-full relative
          ${isExisting ? 'bg-gray-200 hover:bg-gray-200' : ''}
          ${isInPast ? 'opacity-50' : ''}
        `}
        onClick={() => isAvailable && !isInPast && onSlotSelect(slotString)}
        disabled={!isAvailable || isExisting || isInPast}
      >
        <div className="flex flex-col items-center gap-1 text-xs">
          {scheduleType === 'WEEKLY' && isAvailable && <span>🔄</span>}
          {isExisting ? 'Booked' : isSelected ? 'Selected' : isAvailable ? 'Available' : ''}
        </div>
      </Button>
    )
  }

  const renderWeekView = () => {
    const startOfWeek = new Date(currentDate)
    startOfWeek.setDate(currentDate.getDate() - currentDate.getDay())

    return (
      <div className="flex flex-col h-[75vh]">
        <div className="grid grid-cols-8 gap-1">
          <div className="w-20"></div>
          {DAYS.map((day, index) => {
            const date = new Date(startOfWeek)
            date.setDate(startOfWeek.getDate() + index)
            return (
              <div key={day} className="text-center">
                <div className="font-bold">{day}</div>
                <div className="text-sm text-muted-foreground">{date.getDate()}</div>
              </div>
            )
          })}
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-8 gap-1">
            {HOURS.map(hour => (
              <React.Fragment key={hour}>
                <div className="w-20 text-right pr-2 py-2 text-sm">
                  {hour.toString().padStart(2, '0')}:00
                </div>
                {DAYS.map((_, dayIndex) => {
                  const date = new Date(startOfWeek)
                  date.setDate(startOfWeek.getDate() + dayIndex)
                  return (
                    <div key={dayIndex}>
                      {renderTimeCell(date, hour)}
                    </div>
                  )
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const renderMonthView = () => {
    const year = currentDate.getFullYear()
    const month = currentDate.getMonth()
    const firstDayOfMonth = new Date(year, month, 1).getDay()
    const now = new Date()
    const currentDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    return (
      <div className="grid grid-cols-7 gap-1 h-[75vh]">
        {DAYS.map(day => (
          <div key={day} className="text-center font-bold p-2">{day}</div>
        ))}
        {Array.from({ length: firstDayOfMonth }, (_, i) => (
          <div key={`empty-${i}`} className="h-full bg-gray-50/50"></div>
        ))}
        {Array.from({ length: getDaysInMonth(currentDate) }, (_, i) => {
          const date = new Date(year, month, i + 1)
          const dateString = date.toISOString().split('T')[0]
          const daySlots = availableSlots?.filter(slot => slot?.startsWith(dateString)) || []
          const existingSlots = existingAppointments?.filter(slot => slot?.startsWith(dateString)) || []
          const selectedDaySlots = selectedSlots?.filter(slot => slot?.startsWith(dateString)) || []
          const isToday = date.getTime() === currentDayStart.getTime()
          const isPast = date < currentDayStart

          return (
            <Card 
              key={i} 
              className={`h-full ${isToday ? 'ring-2 ring-primary' : ''} ${isPast ? 'bg-gray-50' : ''}`}
            >
              <CardContent className="p-1 h-full flex flex-col">
                <div className={`font-bold bg-background/95 backdrop-blur p-1 flex justify-between items-center ${
                  isToday ? 'text-primary' : ''
                }`}>
                  <span>{i + 1}</span>
                  {daySlots.length > 0 && (
                    <Badge variant="outline" className="text-xs">
                      {daySlots.length}
                    </Badge>
                  )}
                </div>
                <div className="flex-1 space-y-1 mt-1 overflow-y-auto">
                  {daySlots.map((slot, index) => {
                    const slotDate = new Date(slot)
                    const isInPast = slotDate < now
                    const isSelected = selectedDaySlots.includes(slot)
                    const isExisting = existingSlots.includes(slot)

                    return (
                      <Button
                        key={index}
                        variant={isSelected ? "default" : "outline"}
                        size="sm"
                        className={`w-full h-6 text-xs justify-start ${
                          isExisting ? 'bg-gray-200' : ''
                        } ${
                          isInPast ? 'opacity-50' : ''
                        }`}
                        onClick={() => !isInPast && onSlotSelect(slot)}
                        disabled={isExisting || isInPast}
                      >
                        {slotDate.toLocaleTimeString([], { 
                          hour: '2-digit', 
                          minute: '2-digit'
                        })}
                      </Button>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    )
  }


  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-between items-center mb-4">
        <Button variant="outline" onClick={navigatePrevious}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="text-lg font-bold">
          {currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        </div>
        <Button variant="outline" onClick={navigateNext}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex justify-end gap-2 mb-2">
        <Button 
          variant={view === 'week' ? 'default' : 'outline'} 
          size="sm" 
          onClick={() => setView('week')}
        >
          Week
        </Button>
        <Button 
          variant={view === 'month' ? 'default' : 'outline'} 
          size="sm" 
          onClick={() => setView('month')}
        >
          Month
        </Button>
      </div>
      {view === 'week' ? renderWeekView() : renderMonthView()}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <div>Selected: {selectedSlots.length} / {requiredSlots}</div>
          <div className="text-sm text-muted-foreground">
            {consultantTimezone}
          </div>
        </div>
      </div>
    </div>
  )
}