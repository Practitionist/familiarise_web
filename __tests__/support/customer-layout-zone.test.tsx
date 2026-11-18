/**
 * Every customer dashboard layout pins the viewer's profile zone, read on the
 * server, so a support surface outside the Support pages (a chat-opened sheet's
 * bubbles and its reply-by line) prints the profile zone, even with the
 * runtime in UTC.
 */

import { render, screen } from "@testing-library/react";

process.env.TZ = "UTC";

jest.mock("@/lib/time/viewer-zone-server", () => ({
  getViewerZone: async () => ({ zone: "America/Los_Angeles", own: true }),
}));
jest.mock("@/lib/auth-guard", () => ({
  requireOnboarded: async () => ({ user: { id: "u-1" } }),
}));
jest.mock("@/lib/dashboard/profile-access", () => ({
  viewerMayOpenProfile: async () => true,
}));
jest.mock(
  "@/app/dashboard/consultee/[consulteeId]/ConsulteeDashboardLayout",
  () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }),
);
jest.mock(
  "@/app/dashboard/consultant/[consultantId]/ConsultantDashboardLayout",
  () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }),
);

import ConsulteeLayout from "@/app/dashboard/consultee/[consulteeId]/layout";
import ConsultantLayout from "@/app/dashboard/consultant/[consultantId]/layout";
import { SupportBubble } from "@/components/support/SupportBubble";
import { describeWait } from "@/components/support/useSupportThread";
import { useZoneClock } from "@/lib/time/use-zone-clock";

/** What a chat-opened support sheet shows: a reply and the reply-by line. */
function ChatSheet() {
  const clock = useZoneClock();
  return (
    <>
      <SupportBubble
        author="AGENT"
        body="We are on it"
        at="2026-11-16T12:45:00.000Z"
        perspective="user"
      />
      <p>
        {describeWait(
          "2026-11-17T03:00:00.000Z",
          clock.zone,
          new Date("2026-11-16T16:00:00.000Z"),
        )}
      </p>
    </>
  );
}

it.each([
  ["consultee", ConsulteeLayout, { consulteeId: "ce-1" }],
  ["consultant", ConsultantLayout, { consultantId: "cp-1" }],
] as const)(
  "the %s layout prints the profile zone on a chat sheet under TZ=UTC",
  async (_tree, Layout, params) => {
    const tree = await Layout({
      children: <ChatSheet />,
      params: Promise.resolve(params),
    } as never);
    // ViewerZone is an async server component: resolve it as the RSC renderer would.
    const zoned = await tree.type(tree.props);
    render(zoned);
    expect(screen.getByText(/4:45\s?am/i)).toBeTruthy();
    expect(screen.getByText(/reply by 7:00\s?pm PST today/i)).toBeTruthy();
    expect(screen.queryByText(/UTC|IST/)).toBeNull();
  },
);
