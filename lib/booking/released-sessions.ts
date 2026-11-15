import type { Prisma } from "@prisma/client";
import { z } from "zod";

import type { Db, Tx } from "@/lib/prisma";

/**
 * What a reschedule released, recorded on its RescheduleRequest in the release
 * transaction: the durable source of the notice the initiator gave, which
 * survives the released rows being replaced.
 */
export const ReleasedSessionsSchema = z.array(
  z.object({
    ordinal: z.number().int(),
    startsAt: z.string().datetime({ offset: true }),
    /** Unconfirmed (an unpaid hold) when released; a restore puts it back so. */
    tentative: z.boolean().optional(),
  }),
);
export type ReleasedSessions = z.infer<typeof ReleasedSessionsSchema>;

/** Entry i describes `releasedOccurrenceIds[i]`: both come from the same list. */
export function releasedSessionsOf(
  slots: readonly {
    ordinal: number;
    startsAt: Date | string;
    isTentative?: boolean | null;
  }[],
): ReleasedSessions {
  return slots.map((s) => ({
    ordinal: s.ordinal,
    startsAt: new Date(s.startsAt).toISOString(),
    ...(s.isTentative ? { tentative: true } : {}),
  }));
}

/** A request whose sessions really moved: not withdrawn, not restored. */
export type CountedRelease = {
  id: string;
  status: string;
  createdAt: Date;
  sessions: ReleasedSessions;
};

/**
 * The reschedule requests on a booking that moved its sessions, with what each
 * released. A withdrawn request, or one whose ending put the booking back
 * (`restoredAt`), moved nothing; a row with no release record (opened before
 * releases were recorded) is not counted.
 */
export async function countedReleases(
  db: Pick<Db | Tx, "rescheduleRequest">,
  where: Prisma.RescheduleRequestWhereInput,
): Promise<CountedRelease[]> {
  const requests = await db.rescheduleRequest.findMany({
    where: { ...where, status: { not: "WITHDRAWN" }, restoredAt: null },
    select: {
      id: true,
      status: true,
      createdAt: true,
      releasedSessions: true,
    },
  });
  return requests.flatMap((request) => {
    const parsed = ReleasedSessionsSchema.safeParse(request.releasedSessions);
    if (!parsed.success) return [];
    return [
      {
        id: request.id,
        status: request.status,
        createdAt: request.createdAt,
        sessions: parsed.data,
      },
    ];
  });
}
