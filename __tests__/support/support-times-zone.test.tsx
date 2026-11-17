/**
 * Support times: India time in the back office, the viewer's profile zone on a
 * customer page, and the same text whatever zone the server or browser runs in.
 * Worked instant: 12:45 UTC on 16 Nov 2026 is 6:15 pm IST and 4:45 am in Los Angeles.
 */

import { render, screen } from "@testing-library/react";

jest.mock("@/lib/time/viewer-zone-server", () => ({
  getViewerZone: async () => ({ zone: "America/Los_Angeles", own: true }),
}));

import { SupportBubble } from "@/components/support/SupportBubble";
import { describeWait } from "@/components/support/useSupportThread";
import { ViewerZone } from "@/app/support/_components/ViewerZone";
import { shortAge } from "@/lib/support/case-format";
import { parseInboxFilters } from "@/lib/support/inbox-query";
import { OPERATOR_ZONE } from "@/lib/time/operator-zone";
import { zoneClock } from "@/lib/time/zone-clock";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

const AT = "2026-11-16T12:45:00.000Z";
const LA = "America/Los_Angeles";
const RUNTIME_ZONES = ["UTC", LA] as const;
const ORIGINAL_TZ = process.env.TZ;

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe.each(RUNTIME_ZONES)("with the runtime in %s", (runtime) => {
  beforeEach(() => {
    process.env.TZ = runtime;
  });

  it("staff read IST, labelled", () => {
    const ist = zoneClock(OPERATOR_ZONE);
    expect(ist.time(AT)).toMatch(/^6:15\s?pm IST$/i);
    expect(ist.dateTime(AT)).toContain("16 Nov");
  });

  it("a customer in Los Angeles reads their own wall clock", () => {
    const la = zoneClock(LA);
    expect(la.time(AT)).toMatch(/^4:45\s?am$/i);
    expect(la.dateTime(AT)).toMatch(/16 Nov/);
    expect(la.dateTime(AT)).not.toMatch(/6:15|IST/);
  });

  it("a UTC fallback says UTC", () => {
    expect(zoneClock("UTC").time(AT)).toMatch(/^12:45\s?pm UTC$/i);
  });

  it("describeWait reads the time and 'today' in the viewer's zone", () => {
    // 03:00 UTC on 17 Nov: 7:00 pm on 16 Nov in Los Angeles, 8:30 am on 17 Nov in IST.
    const due = "2026-11-17T03:00:00.000Z";
    const now = new Date("2026-11-16T16:00:00.000Z");
    expect(describeWait(due, LA, now)).toMatch(
      /^Our team will reply by 7:00\s?pm today\.$/i,
    );
    expect(describeWait(due, OPERATOR_ZONE, now)).toMatch(
      /^Our team will reply by 8:30\s?am IST on 17 Nov\.$/i,
    );
  });

  it("the inbox age label falls back to the IST day", () => {
    // 20:00 UTC on 30 Nov is 1 Dec in India.
    expect(
      shortAge("2026-11-30T20:00:00.000Z", new Date("2026-12-20T00:00:00Z")),
    ).toBe("1 Dec");
  });

  it("the inbox date filter cuts each day at 00:00 IST", () => {
    const params = new URLSearchParams({
      from: "2026-11-17",
      to: "2026-11-17",
    });
    const f = parseInboxFilters((k) => params.get(k), "op-1");
    expect(f.from?.toISOString()).toBe("2026-11-16T18:30:00.000Z");
    expect(f.to?.toISOString()).toBe("2026-11-17T18:30:00.000Z");
  });

  it("an impossible filter day is ignored", () => {
    const f = parseInboxFilters(
      (k) => (k === "from" ? "2026-02-30" : null),
      "op-1",
    );
    expect(f.from).toBeNull();
  });
});

describe("one bubble, two readers", () => {
  const bubble = (
    <SupportBubble
      author="AGENT"
      body="Refund sent"
      at={AT}
      perspective="user"
    />
  );

  it("prints IST under the back office's provider", () => {
    render(
      <DisplayZoneProvider zone={OPERATOR_ZONE}>{bubble}</DisplayZoneProvider>,
    );
    expect(screen.getByText(/6:15\s?pm IST/i)).toBeTruthy();
  });

  it("prints the customer's zone under their page's provider", () => {
    render(<DisplayZoneProvider zone={LA}>{bubble}</DisplayZoneProvider>);
    expect(screen.getByText(/4:45\s?am/i)).toBeTruthy();
    expect(screen.queryByText(/IST/)).toBeNull();
  });

  it("without any provider reads the browser zone through Intl, not a silent UTC", () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    const spy = jest
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...real.call(this), timeZone: LA };
      });
    render(bubble);
    spy.mockRestore();
    expect(screen.getByText(/4:45\s?am/i)).toBeTruthy();
    expect(screen.queryByText(/UTC/)).toBeNull();
  });
});

it("the customer support shell pins the viewer's profile zone from the server", async () => {
  const element = await ViewerZone({ children: "body" });
  expect(element.props).toMatchObject({ zone: LA, children: "body" });
});
