import { z } from "zod";
import type { WalletTopUpStatus } from "@prisma/client";

/** A top-up's lifecycle as the wallet API reports it: Prisma's status, lowercased. */
export const topUpStatusSchema = z.enum([
  "pending",
  "confirmed",
  "failed",
] as const satisfies readonly Lowercase<WalletTopUpStatus>[]);
export type TopUpStatus = z.infer<typeof topUpStatusSchema>;

const TOP_UP_STATUS: Record<WalletTopUpStatus, TopUpStatus> = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  FAILED: "failed",
};

export function toTopUpStatus(status: WalletTopUpStatus): TopUpStatus {
  return TOP_UP_STATUS[status];
}
