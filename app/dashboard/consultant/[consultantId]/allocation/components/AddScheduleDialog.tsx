import React from 'react';
import { format } from 'date-fns';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NewSlot, DayOfWeek } from '../utils';

interface AddScheduleDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  newSlot: NewSlot;
  setNewSlot: React.Dispatch<React.SetStateAction<NewSlot>>;
  onAddSlot: () => void;
}

export const AddScheduleDialog: React.FC<AddScheduleDialogProps> = ({
  isOpen,
  onOpenChange,
  newSlot,
  setNewSlot,
  onAddSlot,
}) => {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
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
        <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white" onClick={onAddSlot}>Add Schedule</Button>
      </DialogContent>
    </Dialog>
  );
};