/**
 * The grid answer may sit in the browser's HTTP cache for 30 seconds. The
 * first read of a mount has no ETag of its own yet, so it must ask the server
 * to revalidate rather than paint a stored body.
 */
import { AllocationService } from "@/lib/scheduling/allocationService";

const fetchMock = jest.fn();
const START = new Date("2026-11-22T18:30:00.000Z");
const END = new Date("2026-11-29T18:30:00.000Z");

function ok() {
  return {
    status: 200,
    ok: true,
    json: async () => ({ data: {}, leadMs: 900_000 }),
    headers: { get: () => '"v1"' },
  };
}

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok());
});

const read = (bypass?: boolean, etag?: string | null) =>
  AllocationService.fetchAvailabilitySlots(
    "consultant-1",
    START,
    END,
    "Asia/Kolkata",
    false,
    undefined,
    bypass,
    etag,
  );

describe("availability read and the browser cache", () => {
  it("revalidates the first read of a mount", async () => {
    await read(false, null);
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: "no-cache" });
  });

  it("sends its own validator on a poll", async () => {
    await read(false, '"v1"');
    expect(fetchMock.mock.calls[0][1]).toEqual({
      headers: {
        "If-None-Match": '"v1"',
        "X-Availability-If-None-Match": '"v1"',
      },
    });
  });

  it("skips the cache entirely after the caller's own change", async () => {
    await read(true, '"v1"');
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: "no-store" });
  });
});
