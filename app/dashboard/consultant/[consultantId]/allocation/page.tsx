"use client";

import { ArrowLeftIcon, ArrowRightIcon, CalendarIcon, MenuIcon, OptionIcon, SearchIcon, TargetIcon, TimerIcon, UserIcon } from "@/assets/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";
import { useEffect, useState } from 'react';
import { format, startOfWeek, addDays, eachDayOfInterval, startOfMonth, endOfMonth } from 'date-fns';
import {
  SlotOfAvailability,
  NewSlot,
  DayOfWeek,
  navigateCalendar,
  filterSlotsByDay,
  formatSlotTime,
  calculateSlotPosition
} from './utils';

export default function EnhancedSlotAllocationCalendar() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [slots, setSlots] = useState<SlotOfAvailability[]>([]);
  const [isAddScheduleOpen, setIsAddScheduleOpen] = useState(false);
  const [newSlot, setNewSlot] = useState<NewSlot>({
    type: 'weekly',
    dayOfWeekforStartTimeInUTC: 'MONDAY',
    dayOfWeekforEndTimeInUTC: 'MONDAY',
    slotStartTimeInUTC: new Date(),
    slotEndTimeInUTC: new Date(),
  });
  const [view, setView] = useState<'week' | 'month'>('week');

  useEffect(() => {
    fetchSlots();
  }, []);

  const fetchSlots = async () => {
    try {
      const response = await fetch('/api/slots');
      const data = await response.json();
      setSlots(data.map((slot: SlotOfAvailability) => ({
        ...slot,
        slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
        slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC),
      })));
    } catch (error) {
      console.error('Error fetching slots:', error);
      toast({
        title: "Error",
        description: "Failed to fetch slots. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleAddSlot = async () => {
    try {
      const slotToAdd = newSlot.type === 'weekly'
        ? {
            dayOfWeekforStartTimeInUTC: newSlot.dayOfWeekforStartTimeInUTC,
            dayOfWeekforEndTimeInUTC: newSlot.dayOfWeekforEndTimeInUTC,
            slotStartTimeInUTC: newSlot.slotStartTimeInUTC,
            slotEndTimeInUTC: newSlot.slotEndTimeInUTC,
          }
        : {
            slotStartTimeInUTC: newSlot.slotStartTimeInUTC,
            slotEndTimeInUTC: newSlot.slotEndTimeInUTC,
          };

      const response = await fetch('/api/slots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slotToAdd),
      });
      const data = await response.json();
      setSlots([...slots, {
        ...data,
        slotStartTimeInUTC: new Date(data.slotStartTimeInUTC),
        slotEndTimeInUTC: new Date(data.slotEndTimeInUTC),
      }]);
      setIsAddScheduleOpen(false);
      toast({
        title: "Slot added",
        description: `New slot added: ${format(data.slotStartTimeInUTC, 'PPpp')} - ${format(data.slotEndTimeInUTC, 'PPpp')}`,
      });
    } catch (error) {
      console.error('Error adding slot:', error);
      toast({
        title: "Error",
        description: "Failed to add slot. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleCellClick = (day: Date, hour: number) => {
    const startTime = new Date(day);
    startTime.setHours(hour, 0, 0, 0);
    const endTime = new Date(startTime);
    endTime.setHours(hour + 1, 0, 0, 0);

    setNewSlot({
      type: view === 'week' ? 'weekly' : 'custom',
      dayOfWeekforStartTimeInUTC: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][day.getDay()] as DayOfWeek,
      dayOfWeekforEndTimeInUTC: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][day.getDay()] as DayOfWeek,
      slotStartTimeInUTC: startTime,
      slotEndTimeInUTC: endTime,
    });
    setIsAddScheduleOpen(true);
  };

  const getWeekDays = (date: Date) => {
    const start = startOfWeek(date);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  };

  const getMonthDays = (date: Date) => {
    const start = startOfMonth(date);
    const end = endOfMonth(date);
    return eachDayOfInterval({ start, end });
  };

  const renderWeekView = () => {
    const days = getWeekDays(currentDate);

    return (
      <div className="grid grid-cols-8 gap-px bg-gray-200">
        <div className="col-span-1 bg-white">
          <div className="h-12 border-b border-gray-200"></div>
          <div className="relative" style={{ height: 'calc(24 * 3rem)' }}>
            {Array.from({ length: 25 }, (_, i) => (
              <div 
                key={i} 
                className="absolute w-full text-xs text-right pr-2 flex items-center justify-end" 
                style={{ 
                  top: i === 0 ? '0' : i === 24 ? 'calc(24 * 3rem)' : `${i * 3}rem`,
                  transform: i === 0 ? 'translateY(0)' : i === 24 ? 'translateY(-100%)' : 'translateY(-50%)'
                }}
              >
                {format(new Date().setHours(i % 24, 0, 0, 0), 'h a')}
              </div>
            ))}
          </div>
        </div>
        {days.map((day, dayIndex) => (
          <div key={dayIndex} className="col-span-1 bg-white">
            <div className="h-12 text-sm font-medium p-2 text-center border-b border-gray-200">
              {format(day, 'EEE dd')}
            </div>
            <div className="relative" style={{ height: 'calc(24 * 3rem)' }}>
              {Array.from({ length: 24 }, (_, i) => (
                <div 
                  key={i} 
                  className="absolute w-full border-b border-gray-100 cursor-pointer" 
                  style={{ top: `${i * 3}rem`, height: '3rem' }}
                  onClick={() => handleCellClick(day, i)}
                ></div>
              ))}
              {filterSlotsByDay(slots, day, currentDate).map((slot, slotIndex) => {
                const { top, height } = calculateSlotPosition(slot);
                return (
                  <div
                    key={slotIndex}
                    className="absolute left-0 right-0 bg-blue-500 text-white rounded-sm shadow-sm"
                    style={{ top, height, margin: '1px' }}
                  >
                    <div className="text-xs p-1 truncate">
                      {formatSlotTime(slot)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderMonthView = () => {
    const days = getMonthDays(currentDate);

    return (
      <div className="grid grid-cols-7 gap-px bg-gray-200 rounded-lg overflow-hidden">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
          <div key={day} className="text-sm font-medium text-center p-2 bg-gray-100">
            {day}
          </div>
        ))}
        {days.map((day, index) => (
          <div
            key={index}
            className={`p-2 ${
              format(day, 'MM') === format(currentDate, 'MM') ? 'bg-white' : 'bg-gray-50'
            } min-h-[100px] cursor-pointer`}
            onClick={() => handleCellClick(day, 9)} // Default to 9 AM for month view
          >
            <div className="text-sm font-medium mb-1">{format(day, 'd')}</div>
            <div className="space-y-1">
              {filterSlotsByDay(slots, day, currentDate)
                .slice(0, 3)
                .map((slot, slotIndex) => (
                  <div
                    key={slotIndex}
                    className="text-xs p-1 rounded-sm truncate bg-blue-100 text-blue-800 border border-blue-200"
                  >
                    {formatSlotTime(slot)}
                  </div>
                ))}
              {filterSlotsByDay(slots, day, currentDate).length > 3 && (
                <div className="text-xs text-gray-500">More...</div>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      <header className="flex items-center justify-between p-4 bg-white border-b shadow-sm">
        <div className="flex items-center space-x-4">
          <MenuIcon className="w-6 h-6 text-gray-600" />
          <h1 className="text-lg font-semibold text-gray-800">Calendar</h1>
        </div>
        <div className="flex items-center space-x-4">
          <SearchIcon className="w-6 h-6 text-gray-600" />
          <UserIcon className="w-6 h-6 text-gray-600" />
        </div>
      </header>
      <div className="flex flex-1">
        <aside className="w-64 p-4 bg-white border-r">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-gray-800">{format(currentDate, 'MMMM yyyy')}</h2>
          </div>
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-gray-700 mb-2">Scheduled</h2>
            <ul className="space-y-2">
              <li className="flex items-center space-x-2 text-gray-600 hover:text-gray-800">
                <CalendarIcon className="w-4 h-4" />
                <span>Calendars</span>
              </li>
              <li className="flex items-center space-x-2 text-gray-600 hover:text-gray-800">
                <CalendarIcon className="w-4 h-4" />
                <span>Holiday</span>
              </li>
              <li className="flex items-center space-x-2 text-gray-600 hover:text-gray-800">
                <TimerIcon className="w-4 h-4" />
                <span>Reminders</span>
              </li>
              <li className="flex items-center space-x-2 text-gray-600 hover:text-gray-800">
                <TimerIcon className="w-4 h-4" />
                <span>Tasks</span>
              </li>
              <li className="flex items-center space-x-2 text-gray-600 hover:text-gray-800">
                <OptionIcon className="w-4 h-4" />
                <span>Other Calendars</span>
              </li>
              <li className="flex items-center space-x-2 text-gray-600 hover:text-gray-800">
                <TargetIcon className="w-4 h-4" />
                <span>Target</span>
              </li>
            </ul>
          </div>
        </aside>
        <main className="flex-1 p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center space-x-4">
              <Button
                variant={view === 'week' ? 'default' : 'outline'}
                onClick={() => setView('week')}
                className="text-sm font-medium"
              >
                Week
              </Button>
              <Button
                variant={view === 'month' ? 'default' : 'outline'}
                onClick={() => setView('month')}
                className="text-sm font-medium"
              >
                Month
              </Button>
            </div>
            <div className="flex items-center space-x-4">
              <TimerIcon className="w-6 h-6 text-gray-600" />
              <span className="text-lg font-medium text-gray-800">{format(currentDate, 'MMMM yyyy')}</span>
              <Button variant="outline" size="icon" onClick={() => setCurrentDate(prev => navigateCalendar(prev, view, 'prev'))}>
                <ArrowLeftIcon className="w-4 h-4" />
              </Button>
              <Button variant="outline" size="icon" onClick={() => setCurrentDate(prev => navigateCalendar(prev, view, 'next'))}>
                <ArrowRightIcon className="w-4 h-4" />
              </Button>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-md overflow-hidden">
            {view === 'week' ? renderWeekView() : renderMonthView()}
          </div>
          <Dialog open={isAddScheduleOpen} onOpenChange={setIsAddScheduleOpen}>
            <DialogContent className="bg-white">
              <DialogHeader>
                <DialogTitle className="text-gray-800">Add Schedule</DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="slotType">Slot Type</Label>
                  <Select
                    value={newSlot.type}
                    onValueChange={(value: 'weekly' | 'custom') => {
                      setNewSlot(prev => ({
                        ...prev,
                        type: value,
                        dayOfWeekforStartTimeInUTC: value === 'weekly' ? prev.dayOfWeekforStartTimeInUTC : undefined,
                        dayOfWeekforEndTimeInUTC: value === 'weekly' ? prev.dayOfWeekforEndTimeInUTC : undefined,
                      }));
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select slot type" />
                    </SelectTrigger>
                    <SelectContent className="bg-white">
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {newSlot.type === 'weekly' ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="dayOfWeek">Day of Week</Label>
                      <Select
                        value={newSlot.dayOfWeekforStartTimeInUTC}
                        onValueChange={(value: DayOfWeek) => setNewSlot(prev => ({ ...prev, dayOfWeekforStartTimeInUTC: value, dayOfWeekforEndTimeInUTC: value }))}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select day of week" />
                        </SelectTrigger>
                        <SelectContent className="bg-white">
                          {['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((day) => (
                            <SelectItem key={day} value={day}>{day}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="startTime">Start Time</Label>
                      <Input
                        id="startTime"
                        type="time"
                        value={format(newSlot.slotStartTimeInUTC, 'HH:mm')}
                        onChange={(e) => {
                          const [hours, minutes] = e.target.value.split(':');
                          const newDate = new Date(newSlot.slotStartTimeInUTC);
                          newDate.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
                          setNewSlot(prev => ({ ...prev, slotStartTimeInUTC: newDate }));
                        }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="endTime">End Time</Label>
                      <Input
                        id="endTime"
                        type="time"
                        value={format(newSlot.slotEndTimeInUTC, 'HH:mm')}
                        onChange={(e) => {
                          const [hours, minutes] = e.target.value.split(':');
                          const newDate = new Date(newSlot.slotEndTimeInUTC);
                          newDate.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
                          setNewSlot(prev => ({ ...prev, slotEndTimeInUTC: newDate }));
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="startDateTime">Start Date & Time</Label>
                      <Input
                        id="startDateTime"
                        type="datetime-local"
                        value={format(newSlot.slotStartTimeInUTC, "yyyy-MM-dd'T'HH:mm")}
                        onChange={(e) => setNewSlot(prev => ({ ...prev, slotStartTimeInUTC: new Date(e.target.value) }))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="endDateTime">End Date & Time</Label>
                      <Input
                        id="endDateTime"
                        type="datetime-local"
                        value={format(newSlot.slotEndTimeInUTC, "yyyy-MM-dd'T'HH:mm")}
                        onChange={(e) => setNewSlot(prev => ({ ...prev, slotEndTimeInUTC: new Date(e.target.value) }))}
                      />
                    </div>
                  </>
                )}
              </div>
              <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white" onClick={handleAddSlot}>Add Schedule</Button>
            </DialogContent>
          </Dialog>
        </main>
      </div>
    </div>
  );
}
