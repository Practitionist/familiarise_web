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

  const startOfWeek = new Date(currentDate)
  startOfWeek.setDate(currentDate.getDate() - currentDate.getDay())

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear()
    const month = date.getMonth()
    return new Date(year, month + 1, 0).getDate()
  }

  const renderWeekView = () => {
    const startOfWeek = new Date(currentDate)
    startOfWeek.setDate(currentDate.getDate() - currentDate.getDay())
    
    const now = new Date()
    const currentDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    
    return (
      <div className="grid grid-cols-8 gap-1">
        <div className="col-span-1"></div>
        {DAYS.map((day, index) => {
          const date = new Date(startOfWeek)
          date.setDate(startOfWeek.getDate() + index)
          const isToday = date.getTime() === currentDayStart.getTime()
          
          return (
            <div key={day} className={`text-center ${isToday ? 'bg-primary/10 rounded-t-md' : ''}`}>
              <div className="font-bold">{day}</div>
              <div className="text-sm text-muted-foreground">
                {date.getDate()}
              </div>
            </div>
          )
        })}
        {HOURS.map(hour => (
          <React.Fragment key={hour}>
            <div className="text-right pr-2">{hour}:00</div>
            {Array.from({ length: 7 }, (_, i) => {
              const currentSlotDate = new Date(startOfWeek)
              currentSlotDate.setDate(startOfWeek.getDate() + i)
              currentSlotDate.setHours(hour, 0, 0, 0)
              const slotString = currentSlotDate.toISOString()
              const isAvailable = availableSlots?.includes(slotString) || false
              const isExisting = existingAppointments?.includes(slotString) || false
              const isSelected = selectedSlots?.includes(slotString) || false

              const isInPast = currentSlotDate < now
              const isToday = currentSlotDate.getTime() >= currentDayStart.getTime() && 
                             currentSlotDate.getTime() < currentDayStart.getTime() + 24 * 60 * 60 * 1000
              
              return (
                <Button
                  key={i}
                  variant={isSelected ? "default" : isAvailable ? "outline" : "ghost"}
                  className={`h-8 relative
                    ${isExisting ? 'bg-gray-200 hover:bg-gray-200' : ''}
                    ${isToday ? 'bg-primary/5' : ''}
                    ${isInPast ? 'opacity-50' : ''}
                  `}
                  onClick={() => isAvailable && !isInPast && onSlotSelect(slotString)}
                  disabled={!isAvailable || isExisting || isInPast}
                  title={`${new Date(slotString).toLocaleTimeString([], { 
                    hour: '2-digit', 
                    minute: '2-digit'
                  })} - ${new Date(new Date(slotString).getTime() + 60 * 60 * 1000).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit'
                  })} (Your local time)
${new Date(slotString).toLocaleTimeString([], { 
                    hour: '2-digit', 
                    minute: '2-digit',
                    timeZone: consultantTimezone
                  })} - ${new Date(new Date(slotString).getTime() + 60 * 60 * 1000).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: consultantTimezone
                  })} (Consultant's time - ${consultantTimezone})
${isExisting ? 'Booked' : isSelected ? 'Selected' : isAvailable ? 'Available' : 'Unavailable'}
${scheduleType === 'WEEKLY' ? '🔄 Repeats weekly' : '📅 One-time slot'}`}
                >
                  <div className="flex items-center gap-1">
                    {scheduleType === 'WEEKLY' && isAvailable && <span className="text-xs">🔄</span>}
                    {isExisting ? 'Booked' : isSelected ? 'Selected' : isAvailable ? 'Available' : ''}
                  </div>
                  {isToday && hour === now.getHours() && (
                    <div className="absolute left-0 w-full h-0.5 bg-primary"></div>
                  )}
                </Button>
              )
            })}
          </React.Fragment>
        ))}
      </div>
    )
  }

  const renderMonthView = () => {
    const year = currentDate.getFullYear()
    const month = currentDate.getMonth()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const firstDayOfMonth = new Date(year, month, 1).getDay()
    const now = new Date()
    const currentDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    return (
      <div className="grid grid-cols-7 gap-1">
        {DAYS.map(day => (
          <div key={day} className="text-center font-bold p-2">{day}</div>
        ))}
        {Array.from({ length: firstDayOfMonth }, (_, i) => (
          <div key={`empty-${i}`} className="h-32 bg-gray-50/50"></div>
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
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
              className={`h-32 overflow-y-auto relative ${
                isToday ? 'ring-2 ring-primary' : ''
              } ${
                isPast ? 'bg-gray-50' : ''
              }`}
            >
              <CardContent className="p-1">
                <div className={`font-bold sticky top-0 bg-background/95 backdrop-blur p-1 flex justify-between items-center ${
                  isToday ? 'text-primary' : ''
                }`}>
                  <span>{i + 1}</span>
                  {daySlots.length > 0 && (
                    <Badge variant="outline" className="text-xs">
                      {daySlots.length} slot{daySlots.length !== 1 ? 's' : ''}
                    </Badge>
                  )}
                </div>
                <div className="text-xs space-y-1 mt-1">
                  {daySlots.map((slot, index) => {
                    const slotDate = new Date(slot)
                    const isInPast = slotDate < now
                    const isSelected = selectedDaySlots.includes(slot)
                    const isExisting = existingSlots.includes(slot)
                    const slotTime = slotDate.toLocaleTimeString([], { 
                      hour: '2-digit', 
                      minute: '2-digit'
                    })

                    return (
                      <Button
                        key={index}
                        variant={isSelected ? "default" : "outline"}
                        size="sm"
                        className={`w-full justify-start text-left ${
                          isExisting ? 'bg-gray-200 hover:bg-gray-200' : ''
                        } ${
                          isInPast ? 'opacity-50' : ''
                        }`}
                        onClick={() => !isInPast && onSlotSelect(slot)}
                        disabled={isExisting || isInPast}
                        title={`${new Date(slot).toLocaleTimeString([], { 
                          hour: '2-digit', 
                          minute: '2-digit'
                        })} (Your local time)
${new Date(slot).toLocaleTimeString([], { 
                          hour: '2-digit', 
                          minute: '2-digit',
                          timeZone: consultantTimezone
                        })} (Consultant's time - ${consultantTimezone})
${isExisting ? 'Booked' : isSelected ? 'Selected' : isInPast ? 'Past' : 'Available'}
${scheduleType === 'WEEKLY' ? '(Repeats weekly)' : '(One-time slot)'}`}
                      >
                        {slotTime}
                        {isExisting && <span className="ml-1 text-muted-foreground">(Booked)</span>}
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
    <div>
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
      <div className="flex justify-end mb-2">
        <Button variant="outline" size="sm" onClick={() => setView('week')} className={view === 'week' ? 'bg-primary text-primary-foreground' : ''}>Week</Button>
        <Button variant="outline" size="sm" onClick={() => setView('month')} className={view === 'month' ? 'bg-primary text-primary-foreground' : ''}>Month</Button>
      </div>
      {view === 'week' ? renderWeekView() : renderMonthView()}
      <div className="mt-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>Selected slots: {selectedSlots.length} / {requiredSlots}</div>
          <div className="text-sm text-muted-foreground">
            Timezone: {consultantTimezone}
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          Schedule Type: {scheduleType === 'WEEKLY' ? 'Weekly Recurring' : 'Custom Schedule'}
        </div>
        <div className="text-sm border rounded-md p-2 space-y-1">
          <div className="font-medium mb-2">Legend:</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="pointer-events-none">Available</Button>
              <span>Available slot</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="pointer-events-none bg-gray-200">Booked</Button>
              <span>Booked slot</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="default" size="sm" className="pointer-events-none">Selected</Button>
              <span>Selected slot</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="pointer-events-none opacity-50">Unavailable</Button>
              <span>Past/Unavailable</span>
            </div>
            {scheduleType === 'WEEKLY' && (
              <div className="flex items-center gap-2">
                <span className="text-base">🔄</span>
                <span>Repeats weekly</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
