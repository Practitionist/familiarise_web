import React from 'react';
import { DayOfWeek } from '@prisma/client';

interface WeeklySlot {
  id: string;
  dayOfWeekforStartTimeInUTC: DayOfWeek;
  slotStartTimeInUTC: string;
  dayOfWeekforEndTimeInUTC: DayOfWeek;
  slotEndTimeInUTC: string;
}

interface WeeklyAvailabilityProps {
  slots: WeeklySlot[];
  onSlotSelect: (slot: WeeklySlot) => void;
  selectedSlotId?: string;
}

export const WeeklyAvailability: React.FC<WeeklyAvailabilityProps> = ({
  slots,
  onSlotSelect,
  selectedSlotId
}) => {
  const daysOfWeek = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="bg-white rounded-lg shadow-lg p-8 border border-gray-200">
      <h3 className="text-2xl font-semibold mb-6 text-center text-gray-800">Weekly Availability</h3>
      <div className="grid grid-cols-7 gap-6 mb-6">
        {dayLabels.map((day) => (
          <div key={day} className="text-center text-sm font-semibold text-gray-700">{day}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-6">
        {daysOfWeek.map((day) => (
          <div key={day} className="space-y-3">
            {slots
              .filter((slot) => slot.dayOfWeekforStartTimeInUTC === day)
              .map((slot) => {
                const startTime = new Date(`1970-01-01T${slot.slotStartTimeInUTC}`);
                const endTime = new Date(`1970-01-01T${slot.slotEndTimeInUTC}`);
                return (
                  <div
                    key={slot.id}
                    className={`bg-blue-50 rounded-md p-2 cursor-pointer ${
                      selectedSlotId === slot.id ? 'bg-blue-200' : 'hover:bg-blue-100'
                    } transition-all duration-300 shadow-sm hover:shadow-md flex items-center justify-center`}
                    onClick={() => onSlotSelect(slot)}
                  >
                    <div className="text-xs font-medium text-blue-700">
                      {startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} -
                      {endTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
};
