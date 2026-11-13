/**
 * @jest-environment node
 */
/**
 * The availability read is keyed per consultee, so two buyers never share an
 * answer that carries one buyer's own busy times.
 */
import { availabilityQueryKey } from "@/lib/scheduling/use-availability-window";

describe("availabilityQueryKey consulteeUserId scoping", () => {
  it("omits consulteeUserId when not provided and appends it when provided", () => {
    const start = new Date("2026-10-20T00:00:00.000Z");
    const end = new Date("2026-10-26T23:59:59.999Z");

    expect(availabilityQueryKey("consultant-1", start, end, "UTC")).toEqual([
      "availability",
      "consultant-1",
      start.toISOString(),
      end.toISOString(),
      "UTC",
    ]);

    expect(
      availabilityQueryKey("consultant-1", start, end, "UTC", "user-42"),
    ).toEqual([
      "availability",
      "consultant-1",
      start.toISOString(),
      end.toISOString(),
      "UTC",
      "user-42",
    ]);
  });
});
