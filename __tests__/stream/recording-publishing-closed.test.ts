/**
 * @jest-environment node
 */

/** Recordings are included with the booking at launch; a recording can be unpublished but never published. */
const mockUpdate = jest.fn();
const mockRevalidateTag = jest.fn();
const mockRevalidatePath = jest.fn();
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { recording: { update: (args: unknown) => mockUpdate(args) } },
}));
jest.mock("@/lib/auth-server", () => ({
  getSession: jest.fn().mockResolvedValue({ user: { id: "u1" } }),
}));
jest.mock("@/lib/stream/recording-listing-access", () => ({
  guardOwnedListingRecording: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("next/cache", () => ({
  revalidatePath: (p: string) => mockRevalidatePath(p),
  revalidateTag: (t: string) => mockRevalidateTag(t),
  unstable_cache: (fn: unknown) => fn,
}));

import * as listingRoute from "@/app/api/stream/recordings/[recordingId]/publish/route";

describe("recording listing route", () => {
  it("offers unpublish only", () => {
    expect(Object.keys(listingRoute).sort()).toEqual(["DELETE"]);
  });

  it("purges the replays cache tag and pages on unpublish", async () => {
    mockUpdate.mockResolvedValue({
      id: "r1",
      listingStatus: "UNPUBLISHED",
      slug: "intro",
    });
    const res = await listingRoute.DELETE({} as never, {
      params: Promise.resolve({ recordingId: "r1" }),
    });
    expect(res.status).toBe(200);
    expect(mockRevalidateTag).toHaveBeenCalledWith("recordings");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/explore/products");
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/explore/recordings/intro",
    );
  });
});
