import type { getConsultantDetail } from "@/lib/data/consultant-detail";

// Inferred from the lib/data fetcher so plan prices stay number — the raw
// Prisma payload (TConsultantDetailData) re-introduces bigint money (#780)
export type ConsultantDetailData = NonNullable<
  Awaited<ReturnType<typeof getConsultantDetail>>
>;

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
