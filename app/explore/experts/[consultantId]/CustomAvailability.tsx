import React from 'react';

interface CustomSlot {
  id: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
}

interface CustomAvailabilityProps {
  slots: CustomSlot[];
  onSlotSelect: (slot: CustomSlot) => void;
  selectedSlotId?: string;
}

const formatDateTime = (isoString: string): { date: string; time: string } => {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid date');
    }
    return {
      date: date.toLocaleDateString(undefined, { 
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      }),
      time: date.toLocaleTimeString([], { 
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      })
    };
  } catch (error) {
    console.error('Error formatting datetime:', error);
    return { date: 'Invalid Date', time: 'Invalid Time' };
  }
};

export const CustomAvailability: React.FC<CustomAvailabilityProps> = ({
  slots,
  onSlotSelect,
  selectedSlotId
}) => {
  // Get the next 7 days
  const today = new Date();
  const next7Days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    return date;
  });

  // Group slots by date
  const slotsByDate = next7Days.map(date => {
    const dateStr = date.toDateString();
    return {
      date,
      slots: slots
        .filter(slot => {
          const slotDate = new Date(slot.slotStartTimeInUTC);
          return slotDate.toDateString() === dateStr;
        })
        .sort((a, b) => {
          const timeA = new Date(a.slotStartTimeInUTC).getTime();
          const timeB = new Date(b.slotStartTimeInUTC).getTime();
          return timeA - timeB;
        })
    };
  });

  return (
    <div className="bg-white rounded-lg shadow-lg p-8 border border-gray-200">
      <h3 className="text-2xl font-semibold mb-6 text-center text-gray-800">Custom Availability</h3>
      <div className="grid grid-cols-7 gap-6 mb-6">
        {slotsByDate.map(({ date }) => (
          <div key={date.toISOString()} className="text-center">
            <div className="text-sm font-semibold text-gray-700">
              {date.toLocaleDateString(undefined, { weekday: 'short' })}
            </div>
            <div className="text-xs text-gray-500">
              {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-6">
        {slotsByDate.map(({ date, slots: daySlots }) => (
          <div key={date.toISOString()} className="space-y-3">
            {daySlots.map((slot) => {
              const start = formatDateTime(slot.slotStartTimeInUTC);
              const end = formatDateTime(slot.slotEndTimeInUTC);
              
              return (
                <div
                  key={slot.id}
                  className={`bg-green-50 rounded-md p-2 cursor-pointer ${
                    selectedSlotId === slot.id ? 'bg-green-200' : 'hover:bg-green-100'
                  } transition-all duration-300 shadow-sm hover:shadow-md flex items-center justify-center`}
                  onClick={() => onSlotSelect(slot)}
                >
                  <div className="text-xs font-medium text-green-700">
                    {start.time} - {end.time}
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
