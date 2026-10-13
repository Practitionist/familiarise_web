/**
 * Recording Types
 * Prisma payload types for type-safe recording queries
 */

import { Prisma, type Recording } from "@prisma/client";
import type { Db } from "@/lib/prisma";

// #780 — payload types derive from the extended client (Prisma.Result), not
// Prisma.RecordingGetPayload, so BigInt columns (fileSize, plan.price) type
// as number — matching what the client actually returns.
// listPricePaise (#366) is converted by the money extension map, same deal.
export type RecordingRow = Omit<Recording, "fileSize" | "listPricePaise"> & {
  fileSize: number | null;
  listPricePaise: number | null;
};

// ============================================================================
// Recording with Access Control Include Structure
// Used by: RecordingService.getRecordingById()
// ============================================================================

export const recordingWithAccessControlInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meeting: {
      include: {
        occurrence: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: true,
                  },
                },
                class: {
                  include: {
                    classPlan: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type RecordingWithAccessControl = Prisma.Result<
  Db["recording"],
  { include: typeof recordingWithAccessControlInclude },
  "findFirstOrThrow"
>;
