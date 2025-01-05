import { Dispatch, SetStateAction } from "react";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "components/ui/dialog";
import { Button } from "components/ui/button";
import { NewSlot, DAYS_OF_WEEK } from "../utils";

interface AddScheduleDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  newSlot: NewSlot;
  setNewSlot: Dispatch<SetStateAction<NewSlot>>;
  onAddSlot: () => Promise<void>;
}

export function AddScheduleDialog({
  isOpen,
  onOpenChange,
  newSlot,
  setNewSlot,
  onAddSlot,
}: Readonly<AddScheduleDialogProps>) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Schedule</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Schedule Type
            </label>
            <select
              value={newSlot.type}
              onChange={(e) =>
                setNewSlot((prev) => ({
                  ...prev,
                  type: e.target.value as "weekly" | "custom",
                }))
              }
              className="w-full p-2 border rounded-md"
            >
              <option value="weekly">Weekly</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          {newSlot.type === "weekly" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Day of Week
              </label>
              <select
                value={newSlot.dayOfWeekforStartTimeInUTC}
                onChange={(e) =>
                  setNewSlot((prev) => ({
                    ...prev,
                    dayOfWeekforStartTimeInUTC: e.target
                      .value as typeof prev.dayOfWeekforStartTimeInUTC,
                    dayOfWeekforEndTimeInUTC: e.target
                      .value as typeof prev.dayOfWeekforEndTimeInUTC,
                  }))
                }
                className="w-full p-2 border rounded-md"
              >
                {DAYS_OF_WEEK.map((day) => (
                  <option key={day} value={day}>
                    {day.charAt(0) + day.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Start Time
            </label>
            <input
              type="time"
              value={format(newSlot.slotStartTimeInUTC, "HH:mm")}
              onChange={(e) => {
                const [hours, minutes] = e.target.value.split(":");
                const newDate = new Date(newSlot.slotStartTimeInUTC);
                newDate.setHours(parseInt(hours), parseInt(minutes));
                setNewSlot((prev) => ({
                  ...prev,
                  slotStartTimeInUTC: newDate,
                }));
              }}
              className="w-full p-2 border rounded-md"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              End Time
            </label>
            <input
              type="time"
              value={format(newSlot.slotEndTimeInUTC, "HH:mm")}
              onChange={(e) => {
                const [hours, minutes] = e.target.value.split(":");
                const newDate = new Date(newSlot.slotEndTimeInUTC);
                newDate.setHours(parseInt(hours), parseInt(minutes));
                setNewSlot((prev) => ({
                  ...prev,
                  slotEndTimeInUTC: newDate,
                }));
              }}
              className="w-full p-2 border rounded-md"
            />
          </div>
        </div>

        <div className="flex justify-end space-x-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onAddSlot}>Add</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
