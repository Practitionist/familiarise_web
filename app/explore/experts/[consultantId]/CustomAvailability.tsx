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

export const CustomAvailability: React.FC<CustomAvailabilityProps> = ({
  slots,
  onSlotSelect,
  selectedSlotId
}) => {
  const today = new Date();
  const next7Days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    return date;
  });

  return (
    <div className="bg-white rounded-lg shadow-lg p-8 border border-gray-200">
      <h3 className="text-2xl font-semibold mb-6 text-center text-gray-800">Custom Availability</h3>
      <div className="grid grid-cols-7 gap-6 mb-6">
        {next7Days.map((date) => (
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
        {next7Days.map((date) => (
          <div key={date.toISOString()} className="space-y-3">
            {slots
              .filter((slot) => {
                const slotDate = new Date(slot.slotStartTimeInUTC);
                return slotDate.toDateString() === date.toDateString();
              })
              .map((slot) => {
                const startTime = new Date(slot.slotStartTimeInUTC);
                const endTime = new Date(slot.slotEndTimeInUTC);
                return (
                  <div
                    key={slot.id}
                    className={`bg-green-50 rounded-md p-2 cursor-pointer ${
                      selectedSlotId === slot.id ? 'bg-green-200' : 'hover:bg-green-100'
                    } transition-all duration-300 shadow-sm hover:shadow-md flex items-center justify-center`}
                    onClick={() => onSlotSelect(slot)}
                  >
                    <div className="text-xs font-medium text-green-700">
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
