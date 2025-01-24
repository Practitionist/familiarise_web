import React, { useState } from 'react'
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ChevronLeft, ChevronRight } from 'lucide-react'

type CalendarProps = {
  availableSlots: string[] | undefined
  existingAppointments: string[] | undefined
  onSlotSelect: (slot: string) => void
  selectedSlots: string[] | undefined
  requiredSlots: number
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = Array.from({ length: 24 }, (_, i) => i)

export function Calendar({ 
  availableSlots = [], 
  existingAppointments = [], 
  onSlotSelect, 
  selectedSlots = [], 
  requiredSlots 
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
    return (
      <div className="grid grid-cols-8 gap-1">
        <div className="col-span-1"></div>
        {DAYS.map(day => (
          <div key={day} className="text-center font-bold">{day}</div>
        ))}
        {HOURS.map(hour => (
          <React.Fragment key={hour}>
            <div className="text-right pr-2">{hour}:00</div>
            {Array.from({ length: 7 }, (_, i) => {
              const slotDate = new Date(startOfWeek)
              slotDate.setDate(startOfWeek.getDate() + i)
              slotDate.setHours(hour, 0, 0, 0)
              const slotString = slotDate.toISOString()
              const isAvailable = availableSlots?.includes(slotString) || false
              const isExisting = existingAppointments?.includes(slotString) || false
              const isSelected = selectedSlots?.includes(slotString) || false

              return (
                <Button
                  key={i}
                  variant={isSelected ? "default" : isAvailable ? "outline" : "ghost"}
                  className={`h-8 ${isExisting ? 'bg-gray-200' : ''}`}
                  onClick={() => isAvailable && onSlotSelect(slotString)}
                  disabled={!isAvailable || isExisting}
                >
                  {isExisting ? 'Booked' : isSelected ? 'Selected' : isAvailable ? 'Available' : ''}
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

    return (
      <div className="grid grid-cols-7 gap-1">
        {DAYS.map(day => (
          <div key={day} className="text-center font-bold">{day}</div>
        ))}
        {Array.from({ length: firstDayOfMonth }, (_, i) => (
          <div key={`empty-${i}`} className="h-24"></div>
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const date = new Date(year, month, i + 1)
          const dateString = date.toISOString().split('T')[0]
          const daySlots = availableSlots?.filter(slot => slot?.startsWith(dateString)) || []
          const existingSlots = existingAppointments?.filter(slot => slot?.startsWith(dateString)) || []
          const selectedDaySlots = selectedSlots?.filter(slot => slot?.startsWith(dateString)) || []

          return (
            <Card key={i} className="h-24 overflow-y-auto">
              <CardContent className="p-1">
                <div className="font-bold">{i + 1}</div>
                <div className="text-xs">
                  {daySlots.map((slot, index) => {
                    const slotTime = new Date(slot).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    const isSelected = selectedDaySlots.includes(slot)
                    const isExisting = existingSlots.includes(slot)
                    return (
                      <Button
                        key={index}
                        variant={isSelected ? "default" : "outline"}
                        size="sm"
                        className={`m-1 ${isExisting ? 'bg-gray-200' : ''}`}
                        onClick={() => onSlotSelect(slot)}
                        disabled={isExisting}
                      >
                        {slotTime}
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
      <div className="mt-4">
        Selected slots: {selectedSlots.length} / {requiredSlots}
      </div>
    </div>
  )
}
