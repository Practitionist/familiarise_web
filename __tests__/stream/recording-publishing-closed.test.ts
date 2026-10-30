/**
 * @jest-environment node
 */

/** Recordings are included with the booking at launch; a recording can be unpublished but never published. */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));

import * as listingRoute from "@/app/api/stream/recordings/[recordingId]/publish/route";

describe("recording listing route", () => {
  it("offers unpublish only", () => {
    expect(Object.keys(listingRoute).sort()).toEqual(["DELETE"]);
  });
});
