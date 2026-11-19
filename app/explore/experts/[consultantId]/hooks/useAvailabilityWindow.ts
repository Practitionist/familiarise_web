/**
 * Checkout's one-shot re-ask of the grid before Pay. The polling readers the
 * expert page and the pickers share live in lib/scheduling/use-availability-window.
 */
import { z } from "zod";

const gridAnswerSchema = z.object({
  data: z
    .record(
      z.string(),
      z.array(
        z.object({
          startsAt: z.string(),
          isAllocated: z.boolean().optional(),
          bookingStatus: z.string().optional(),
          tooSoon: z.boolean().optional(),
          beyondHorizon: z.boolean().optional(),
          limitReached: z.boolean().optional(),
        }),
      ),
    )
    .nullish(),
});

const ATOM_MS = 30 * 60 * 1000;

/**
 * Whether the grid still offers every 30-minute atom of [startsAt, endsAt) as free. Fails open on
 * any read failure: checkout's recheck under the lock stays the arbiter.
 */
export async function isSlotStillOffered(
  consultantId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<boolean> {
  const url = `/api/scheduling/availability-with-allocation/${consultantId}?startDateInUtc=${startsAt.toISOString()}&endDateInUtc=${endsAt.toISOString()}&timezone=UTC`;
  const response = await fetch(url, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return true;
  const body: unknown = await response.json().catch(() => null);
  const parsed = gridAnswerSchema.safeParse(body);
  if (!parsed.success) return true;
  const free = new Set(
    Object.values(parsed.data.data ?? {})
      .flat()
      .filter(
        (s) =>
          !s.isAllocated &&
          s.bookingStatus === "available" &&
          !s.tooSoon &&
          !s.beyondHorizon &&
          !s.limitReached,
      )
      .map((s) => new Date(s.startsAt).getTime()),
  );
  for (let t = startsAt.getTime(); t < endsAt.getTime(); t += ATOM_MS) {
    if (!free.has(t)) return false;
  }
  return true;
}
