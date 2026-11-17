/**
 * @jest-environment node
 */

/**
 * FAMILIARISE_WEB-2V / #1703 B10 — the event-slots read admits the delivering
 * consultant whose session predates their profile (fresh DB read), and the
 * requesting consultee whose picker names the consultant's id, but only when
 * an event id bounds the read; a stranger with the same query is refused.
 */

import prisma from "@/lib/prisma";
import { canReadEventSlots } from "@/lib/booking/event-slots-access";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    consultation: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    webinar: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    membership: { count: jest.fn() },
  },
}));

const userFindUnique = prisma.user.findUnique as jest.Mock;
const subscriptionFindUnique = prisma.subscription.findUnique as jest.Mock;

const noEvent = {
  consultationId: null,
  subscriptionId: null,
  webinarId: null,
  classId: null,
};

describe("canReadEventSlots", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    subscriptionFindUnique.mockResolvedValue({
      requestedById: "consultee-1",
      subscriptionPlan: { consultantProfileId: "consultant-1" },
    });
  });

  it("admits the consultant whose fresh profile id matches the filter", async () => {
    userFindUnique.mockResolvedValue({
      consultantProfileId: "consultant-1",
      consulteeProfileId: null,
    });
    await expect(
      canReadEventSlots({
        userId: "u1",
        filter: {
          consultantProfileId: "consultant-1",
          consulteeProfileId: null,
        },
        eventIds: noEvent,
      }),
    ).resolves.toBe(true);
  });

  it("admits the requesting consultee of a named subscription", async () => {
    userFindUnique.mockResolvedValue({
      consultantProfileId: null,
      consulteeProfileId: "consultee-1",
    });
    await expect(
      canReadEventSlots({
        userId: "u2",
        filter: {
          consultantProfileId: "consultant-1",
          consulteeProfileId: null,
        },
        eventIds: { ...noEvent, subscriptionId: "sub-1" },
      }),
    ).resolves.toBe(true);
  });

  it("refuses a stranger, and refuses the consultee without an event id", async () => {
    userFindUnique.mockResolvedValue({
      consultantProfileId: "consultant-9",
      consulteeProfileId: "consultee-9",
    });
    await expect(
      canReadEventSlots({
        userId: "u3",
        filter: {
          consultantProfileId: "consultant-1",
          consulteeProfileId: null,
        },
        eventIds: { ...noEvent, subscriptionId: "sub-1" },
      }),
    ).resolves.toBe(false);

    userFindUnique.mockResolvedValue({
      consultantProfileId: null,
      consulteeProfileId: "consultee-1",
    });
    await expect(
      canReadEventSlots({
        userId: "u2",
        filter: {
          consultantProfileId: "consultant-1",
          consulteeProfileId: null,
        },
        eventIds: noEvent,
      }),
    ).resolves.toBe(false);
  });

  it("admits the named expert of an organisation's webinar only while an active expert of that organisation", async () => {
    userFindUnique.mockResolvedValue({
      consultantProfileId: "consultant-1",
      consulteeProfileId: null,
    });
    (prisma.webinar.findUnique as jest.Mock).mockResolvedValue({
      webinarPlan: {
        consultantProfileId: "consultant-1",
        organizationId: "org-1",
      },
    });
    const membershipCount = prisma.membership.count as jest.Mock;
    const read = () =>
      canReadEventSlots({
        userId: "u1",
        filter: { consultantProfileId: null, consulteeProfileId: null },
        eventIds: { ...noEvent, webinarId: "web-1" },
      });

    membershipCount.mockResolvedValue(1);
    await expect(read()).resolves.toBe(true);
    expect(membershipCount).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        consultantProfileId: "consultant-1",
        status: "ACTIVE",
        role: "EXPERT",
      },
    });

    membershipCount.mockResolvedValue(0);
    await expect(read()).resolves.toBe(false);
  });

  it("reads no membership for a personal plan's expert", async () => {
    userFindUnique.mockResolvedValue({
      consultantProfileId: "consultant-1",
      consulteeProfileId: null,
    });
    (prisma.webinar.findUnique as jest.Mock).mockResolvedValue({
      webinarPlan: {
        consultantProfileId: "consultant-1",
        organizationId: null,
      },
    });
    await expect(
      canReadEventSlots({
        userId: "u1",
        filter: { consultantProfileId: null, consulteeProfileId: null },
        eventIds: { ...noEvent, webinarId: "web-1" },
      }),
    ).resolves.toBe(true);
    expect(prisma.membership.count).not.toHaveBeenCalled();
  });
});
