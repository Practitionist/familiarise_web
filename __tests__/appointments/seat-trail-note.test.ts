/**
 * @jest-environment node
 */

/** A failed seat-history read is an error the query retries, never an empty trail cached for a minute. */
import { fetchSeatTrail } from "@/lib/booking/seat-trail-fetch";

const reply = (status: number, body: unknown) =>
  jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));

afterEach(() => jest.restoreAllMocks());

it("rejects a failed read so it is not cached as an empty trail", async () => {
  reply(500, { error: "Failed to load your seat history" });
  await expect(fetchSeatTrail("appt-1")).rejects.toThrow(/seat history/);
});

it("returns the trail the route answered, an empty one included", async () => {
  reply(200, {
    steps: [{ reason: "self_leave", at: "2026-11-12T09:00:00.000Z" }],
  });
  await expect(fetchSeatTrail("appt-1")).resolves.toEqual({
    steps: [{ reason: "self_leave", at: "2026-11-12T09:00:00.000Z" }],
  });
  reply(200, { steps: [] });
  await expect(fetchSeatTrail("appt-1")).resolves.toEqual({ steps: [] });
});
