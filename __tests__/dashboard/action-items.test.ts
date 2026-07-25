/**
 * The "needs you now" queue is the one part of the home-page rework with real
 * logic in it, so it lives in a pure module and is pinned here. The bar it
 * encodes: an item appears only when the user is the one blocking something
 * and there is a single obvious next click.
 */

import {
  deriveConsultantActionItems,
  deriveConsulteeActionItems,
  imminentSessionItem,
} from "@/lib/dashboard/action-items";

const CONSULTANT_BASE = "/dashboard/consultant/c1";
const CONSULTEE_BASE = "/dashboard/consultee/e1";

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

describe("imminentSessionItem", () => {
  it("surfaces nothing when the next session is beyond the hour", () => {
    expect(
      imminentSessionItem(
        [{ startsAt: inMinutes(90), title: "Later" }],
        "/x",
      ),
    ).toBeNull();
  });

  it("warns about a session inside the hour", () => {
    const item = imminentSessionItem(
      [{ startsAt: inMinutes(40), title: "Career review" }],
      "/x",
    );
    expect(item?.severity).toBe("warning");
    expect(item?.title).toMatch(/Session in 4[01] min/);
    expect(item?.ctaLabel).toBe("View");
  });

  it("escalates to Join once inside the 10-minute join window", () => {
    const item = imminentSessionItem(
      [{ startsAt: inMinutes(5), title: "Career review" }],
      "/x",
    );
    expect(item?.severity).toBe("critical");
    expect(item?.ctaLabel).toBe("Join");
  });

  it("keeps a session that has just started, and drops one long finished", () => {
    expect(
      imminentSessionItem([{ startsAt: inMinutes(-5), title: "Now" }], "/x"),
    ).not.toBeNull();
    expect(
      imminentSessionItem([{ startsAt: inMinutes(-45), title: "Over" }], "/x"),
    ).toBeNull();
  });

  it("surfaces only the soonest — a list belongs on the Appointments tab", () => {
    const item = imminentSessionItem(
      [
        { startsAt: inMinutes(50), title: "Second" },
        { startsAt: inMinutes(20), title: "First" },
      ],
      "/x",
    );
    expect(item?.body).toBe("First");
  });
});

describe("deriveConsultantActionItems", () => {
  it("is empty when nothing is blocked on the consultant", () => {
    expect(
      deriveConsultantActionItems({
        pendingApprovals: 0,
        upcomingSessions: [{ startsAt: inMinutes(600), title: "Far off" }],
        basePath: CONSULTANT_BASE,
      }),
    ).toEqual([]);
  });

  it("raises slot allocation and links to Requests", () => {
    const [item] = deriveConsultantActionItems({
      pendingApprovals: 3,
      upcomingSessions: [],
      basePath: CONSULTANT_BASE,
    });
    expect(item.title).toBe("3 requests need slot allocation");
    expect(item.ctaHref).toBe(`${CONSULTANT_BASE}/requests`);
  });

  it("uses singular wording for one item", () => {
    const [item] = deriveConsultantActionItems({
      pendingApprovals: 1,
      upcomingSessions: [],
      basePath: CONSULTANT_BASE,
    });
    expect(item.title).toBe("1 request needs slot allocation");
  });

  it("orders the imminent session ahead of the backlog", () => {
    const items = deriveConsultantActionItems({
      pendingApprovals: 2,
      documentsAwaitingReview: 1,
      upcomingSessions: [{ startsAt: inMinutes(5), title: "Now" }],
      basePath: CONSULTANT_BASE,
    });
    expect(items.map((i) => i.key)).toEqual([
      "session-imminent",
      "pending-requests",
      "documents-review",
    ]);
  });
});

describe("deriveConsulteeActionItems", () => {
  it("treats an outstanding payment as critical — the booking isn't confirmed", () => {
    const [item] = deriveConsulteeActionItems({
      pendingPaymentCount: 2,
      pendingPaymentTotalPaise: 124_000,
      upcomingSessions: [],
      basePath: CONSULTEE_BASE,
    });
    expect(item.severity).toBe("critical");
    expect(item.title).toContain("₹1,240");
    expect(item.ctaHref).toBe(`${CONSULTEE_BASE}/payments`);
  });

  it("omits the amount when it isn't known", () => {
    const [item] = deriveConsulteeActionItems({
      pendingPaymentCount: 1,
      upcomingSessions: [],
      basePath: CONSULTEE_BASE,
    });
    expect(item.title).toBe("1 payment is outstanding");
  });

  it("is empty with nothing owed and nothing imminent", () => {
    expect(
      deriveConsulteeActionItems({
        pendingPaymentCount: 0,
        upcomingSessions: [],
        basePath: CONSULTEE_BASE,
      }),
    ).toEqual([]);
  });
});
