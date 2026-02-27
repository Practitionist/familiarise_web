export type OriginalSlotData = {
  id: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
};

export interface ProcessedSlot {
  id: string;
  localStartTime: string;
  localEndTime: string;
  originalSlot: OriginalSlotData;
  isAllocated?: boolean;
  bookingStatus?: "available" | "partially-booked" | "fully-booked";
  slotStartTimeInUTC?: string;
  slotEndTimeInUTC?: string;
  type?: "WEEKLY" | "CUSTOM";
}
