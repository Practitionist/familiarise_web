/** @jest-environment node */
const mockGuard = jest.fn();
const mockUser = jest.fn();
jest.mock("@/lib/meetings/route-guard", () => ({
  guardMeetingRoute: (...args: unknown[]) => mockGuard(...args),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { user: { findUnique: (...args: unknown[]) => mockUser(...args) } },
}));

import { GET } from "@/app/api/meetings/[meetingId]/support/route";

const params = Promise.resolve({ meetingId: "call-1" });

it.each([
  [
    "host",
    { consultantProfileId: "cp-1", consulteeProfileId: null },
    "/dashboard/consultant/cp-1/support/requests/b_appt-1",
  ],
  [
    "participant",
    { consultantProfileId: null, consulteeProfileId: "ce-1" },
    "/dashboard/consultee/ce-1/support/requests/b_appt-1",
  ],
])(
  "sends the %s to a booking support page that accepts booking keys",
  async (role, profiles, href) => {
    mockGuard.mockResolvedValue({
      ok: true,
      userId: "u-1",
      meetingId: "call-1",
      access: { role, appointment: { id: "appt-1" } },
    });
    mockUser.mockResolvedValue(profiles);
    const response = await GET(new Request("http://test"), { params });
    expect(await response.json()).toEqual({ href });
  },
);
