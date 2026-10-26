/**
 * @jest-environment node
 */

/**
 * #1280 PR F — direct-message channels, keyed on PAIR dormancy.
 *
 * Two things make this different from the event stage it shares a job with, and
 * both are load-bearing.
 *
 * An event ends on a schedule and never resumes, so a frozen event channel stays
 * frozen correctly. A pair resumes — they book again. Without a reversal, the
 * first thing a returning consultee finds is a channel they cannot post in, and
 * because Stream grants `use-frozen-channel` to no role there is no error text
 * explaining why. Freezing without unfreezing would be a worse bug than never
 * freezing at all.
 *
 * And the ledger is a property of the PAIR, not of a booking. DM ids are keyed
 * on the pair and `DM_ELIGIBLE_STATUSES` deliberately includes `COMPLETED`, so
 * the read takes MAX(chatFrozenAt) across every booking the pair shares and the
 * write has to cover all of them. Stamping one row would let a second booking
 * report the channel as unfrozen while it was not.
 */

const mockConsultationFindMany = jest.fn();
const mockSubscriptionFindMany = jest.fn();
const mockOrganizationFindMany = jest.fn();
const mockAppointmentFindMany = jest.fn();
const mockLatestOccurrence = jest.fn();
const mockConsultationUpdateMany = jest.fn();
const mockSubscriptionUpdateMany = jest.fn();
const mockUpdatePartial = jest.fn();
const mockDeleteChannels = jest.fn();
const mockQueryChannels = jest.fn();
const mockSendMessage = jest.fn();
/**
 * Captures `(type, id)` for every `client.channel()` call.
 *
 * Without it no test asserts WHICH channel was frozen: the identity case below
 * re-derived both ids from `getDmChannelId` and compared them to each other,
 * which passes even if the job addressed the wrong channel or the wrong Stream
 * type. `lib/stream-channel-ids.ts` records that a wrong type resolved silently
 * for months, which is exactly the failure this suite should catch.
 */
const mockChannel = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: {
      findMany: (...a: unknown[]) => mockConsultationFindMany(...a),
      updateMany: (...a: unknown[]) => mockConsultationUpdateMany(...a),
    },
    subscription: {
      findMany: (...a: unknown[]) => mockSubscriptionFindMany(...a),
      updateMany: (...a: unknown[]) => mockSubscriptionUpdateMany(...a),
    },
    organization: {
      findMany: (...a: unknown[]) => mockOrganizationFindMany(...a),
    },
    appointment: {
      findMany: (...a: unknown[]) => mockAppointmentFindMany(...a),
    },
    appointmentOccurrence: {
      findFirst: (...args: unknown[]) => mockLatestOccurrence(...args),
    },
    webinar: { updateMany: jest.fn() },
    class: { updateMany: jest.fn() },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/redis", () => ({
  createCircuitBreaker: () => ({ run: (run: () => Promise<unknown>) => run() }),
}));

jest.mock("../../lib/stream-client", () => ({
  isExpectedStreamError: jest.requireActual<
    typeof import("../../lib/stream-client")
  >("../../lib/stream-client").isExpectedStreamError,
  isStreamConfigured: () => true,
  getStreamChatClient: () => ({
    channel: (...args: unknown[]) => {
      mockChannel(...args);
      return {
        updatePartial: (...a: unknown[]) => mockUpdatePartial(...a),
        sendMessage: (...a: unknown[]) => mockSendMessage(...a),
      };
    },
    deleteChannels: (...a: unknown[]) => mockDeleteChannels(...a),
    queryChannels: (...a: unknown[]) => mockQueryChannels(...a),
  }),
  withStreamCircuitBreaker: jest.requireActual<
    typeof import("../../lib/stream-client")
  >("../../lib/stream-client").withStreamCircuitBreaker,
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  readJobCheckpoint: jest.fn().mockResolvedValue(null),
  withCronLock: (_n: string, _o: unknown, fn: () => unknown) => fn(),
}));

jest.mock("../../lib/stream/batch", () => ({
  ...jest.requireActual("../../lib/stream/batch"),
  pause: jest.fn(async () => undefined),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { warn: jest.fn(), info: jest.fn(), fmt: (s: unknown) => s },
}));

jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));

import * as Sentry from "@sentry/nextjs";
import { readJobCheckpoint } from "../../lib/cron/with-cron-lock";
import { expireEventChannels } from "../../jobs/stream/expire-event-channels";
import { getDmChannelId } from "../../lib/stream-utils";

const DAY = 24 * 60 * 60 * 1000;
const CONSULTANT = "user-consultant";
const CONSULTEE = "user-consultee";

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY);
}

/** One DM-eligible consultation for the pair, with a given last session end. */
function consultation(
  id: string,
  lastSessionDaysAgo: number,
  chatFrozenAt: Date | null = null,
  organizationId: string | null = null,
) {
  return {
    id,
    chatFrozenAt,
    requestedBy: { user: { id: CONSULTEE } },
    consultationPlan: {
      organizationId,
      consultantProfile: { user: { id: CONSULTANT } },
    },
    appointment: {
      organizationId,
      occurrences: [{ endsAt: daysAgo(lastSessionDaysAgo) }],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(readJobCheckpoint).mockResolvedValue(null);
  mockConsultationFindMany.mockResolvedValue([]);
  mockSubscriptionFindMany.mockResolvedValue([]);
  mockOrganizationFindMany.mockResolvedValue([]);
  mockAppointmentFindMany.mockResolvedValue([]);
  mockLatestOccurrence.mockResolvedValue(null);
  mockConsultationUpdateMany.mockResolvedValue({ count: 1 });
  mockSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
  mockUpdatePartial.mockResolvedValue(undefined);
  mockDeleteChannels.mockResolvedValue(undefined);
  mockQueryChannels.mockResolvedValue([]);
  mockSendMessage.mockResolvedValue(undefined);
  mockChannel.mockReset();
});

describe("DM dormancy — freeze", () => {
  it("leaves an ACTIVE pair alone", async () => {
    // Two weeks between sessions is ordinary for a consulting relationship.
    // Freezing here would be a product regression dressed up as hygiene.
    mockConsultationFindMany.mockResolvedValue([consultation("c1", 14)]);

    const result = await expireEventChannels();

    expect(result.dmFrozen).toBe(0);
    expect(mockUpdatePartial).not.toHaveBeenCalled();
  });

  it("freezes a pair dormant past 90 days", async () => {
    mockConsultationFindMany.mockResolvedValue([consultation("c1", 120)]);

    const result = await expireEventChannels();

    expect(result.dmFrozen).toBe(1);
    expect(mockUpdatePartial).toHaveBeenCalledWith({ set: { frozen: true } });
  });

  it("announces the freeze BEFORE applying it", async () => {
    // Stream grants `use-frozen-channel` to no role, so a frozen channel
    // refuses every send with no error text. Sending after the freeze would
    // itself be refused — the order is the whole point.
    const order: string[] = [];
    mockSendMessage.mockImplementation(async () => {
      order.push("notice");
    });
    mockUpdatePartial.mockImplementation(async () => {
      order.push("freeze");
    });
    mockConsultationFindMany.mockResolvedValue([consultation("c1", 120)]);

    await expireEventChannels();

    expect(order).toEqual(["notice", "freeze"]);
  });

  it("measures dormancy on the pair's MOST RECENT booking", async () => {
    // An old completed consultation plus a recent one. `DM_ELIGIBLE_STATUSES`
    // includes COMPLETED precisely so a finished booking keeps the conversation
    // open, so keying on the older row would freeze a live relationship.
    mockConsultationFindMany.mockResolvedValue([
      consultation("old", 400),
      consultation("recent", 3),
    ]);

    const result = await expireEventChannels();

    expect(result.dmFrozen).toBe(0);
    expect(result.dmDeleteRequests).toBe(0);
  });

  it("does not re-freeze a pair the ledger already covers", async () => {
    mockConsultationFindMany.mockResolvedValue([
      consultation("c1", 120, daysAgo(5)),
    ]);

    const result = await expireEventChannels();

    // Each redundant updatePartial burns one of the 300/min app-wide budget.
    // That is how the 2026-08-23 burst happened.
    expect(result.dmFrozen).toBe(0);
    expect(result.skippedAlreadyFrozen).toBe(1);
    expect(mockUpdatePartial).not.toHaveBeenCalled();
  });
});

describe("DM dormancy — unfreeze, the branch the design turns on", () => {
  it("unfreezes a frozen pair that booked again", async () => {
    mockConsultationFindMany.mockResolvedValue([
      // Frozen while dormant, then a new session three days ago.
      consultation("old", 200, daysAgo(30)),
      consultation("new", 3),
    ]);

    const result = await expireEventChannels();

    expect(result.dmUnfrozen).toBe(1);
    expect(mockUpdatePartial).toHaveBeenCalledWith({ set: { frozen: false } });
  });

  it("clears the ledger across EVERY booking the pair shares", async () => {
    mockConsultationFindMany.mockResolvedValue([
      consultation("old", 200, daysAgo(30)),
      consultation("new", 3),
    ]);

    await expireEventChannels();

    // The read takes MAX(chatFrozenAt) across the pair, so leaving one row
    // stamped would report the channel as still frozen when it is not.
    const [args] = mockConsultationUpdateMany.mock.calls[0] as [
      { where: { id: { in: string[] } }; data: { chatFrozenAt: Date | null } },
    ];
    expect(args.where.id.in.sort()).toEqual(["new", "old"]);
    expect(args.data.chatFrozenAt).toBeNull();
  });

  it("does not announce an unfreeze", async () => {
    mockConsultationFindMany.mockResolvedValue([
      consultation("old", 200, daysAgo(30)),
      consultation("new", 3),
    ]);

    await expireEventChannels();

    // The channel simply works again. A "you may post now" notice in a
    // conversation nobody has touched for months is noise.
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

describe("DM dormancy — identity and retention", () => {
  it("keeps the personal and org-funded channels of one pair APART", async () => {
    // The id is a function of the pair AND the funding context, so the same two
    // people hold two channels. An org relationship can end while the personal
    // one continues; collapsing them would freeze the wrong conversation.
    mockOrganizationFindMany.mockResolvedValue([
      { id: "org-1", chatRetentionDays: 365 },
    ]);
    mockConsultationFindMany.mockResolvedValue([
      consultation("personal", 3),
      consultation("org", 200, null, "org-1"),
    ]);

    const result = await expireEventChannels();

    expect(result.dmFrozen).toBe(1);

    const personalId = getDmChannelId(CONSULTANT, CONSULTEE);
    const orgChannelId = getDmChannelId(CONSULTANT, CONSULTEE, "org-1");
    expect(personalId).not.toBe(orgChannelId);

    // The org channel is the dormant one, so it — and only it — is addressed.
    // Asserting the derived ids against each other proves nothing about what
    // the job actually did; asserting the call does.
    expect(mockChannel).toHaveBeenCalledWith("messaging", orgChannelId);
    expect(mockChannel).not.toHaveBeenCalledWith("messaging", personalId);
  });

  it("deletes past retention rather than freezing", async () => {
    mockConsultationFindMany.mockResolvedValue([consultation("c1", 400)]);

    const result = await expireEventChannels();

    expect(result.dmDeleteRequests).toBe(1);
    expect(result.dmFrozen).toBe(0);
    expect(mockDeleteChannels).toHaveBeenCalled();
  });

  it("honours a shorter per-org retention dial", async () => {
    mockOrganizationFindMany.mockResolvedValue([
      { id: "org-1", chatRetentionDays: 120 },
    ]);
    mockConsultationFindMany.mockResolvedValue([
      consultation("c1", 150, null, "org-1"),
    ]);

    const result = await expireEventChannels();

    // 150 days is under the 365 default but past this org's 120.
    expect(result.dmDeleteRequests).toBe(1);
  });

  it("REFUSES to delete when the booking page was truncated", async () => {
    // The critical case. Both queries cap at MAX_DM_PAIRS_PER_RUN and order by
    // `requestedAt`, which is not the key dormancy is measured on — a booking
    // requested once and running for years sorts old and is the first thing a
    // full page drops. If a pair keeps a low-activity booking and loses its
    // active one, `lastActivityAt` comes from the stale row, the pair reads as
    // past retention, and `hard_delete: true` destroys the chat history of a
    // live consulting relationship.
    const full = Array.from({ length: 5000 }, (_, i) =>
      consultation(`c${i}`, 400),
    );
    mockConsultationFindMany.mockResolvedValue(full);

    const result = await expireEventChannels();

    expect(mockDeleteChannels).not.toHaveBeenCalled();
    expect(result.dmDeleteRequests).toBe(0);
    // Reported, not silent: a run that skipped work must not pass green.
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("truncated"))).toBe(true);
  });

  it("still FREEZES on a truncated page, because freezing is reversible", async () => {
    // Withholding the freeze too would be over-correction. An over-eager freeze
    // is undone by the next run's unfreeze branch; a hard delete is not undone
    // by anything.
    const full = Array.from({ length: 5000 }, (_, i) =>
      consultation(`c${i}`, 120),
    );
    mockConsultationFindMany.mockResolvedValue(full);

    const result = await expireEventChannels();

    expect(result.dmFrozen).toBeGreaterThan(0);
  });

  it("widens the scan window for an org whose retention exceeds the constant", async () => {
    // `MAX_RETENTION_DAYS` is 365. An org on 500 days would have every booking
    // dropped by a window derived from the constant, and get no deletion at all
    // — silently, and in the direction of keeping personal data forever.
    mockOrganizationFindMany.mockResolvedValue([
      { id: "org-1", chatRetentionDays: 500 },
    ]);
    mockConsultationFindMany.mockResolvedValue([
      consultation("c1", 520, null, "org-1"),
    ]);

    const result = await expireEventChannels();

    expect(result.dmDeleteRequests).toBe(1);
  });

  it("does not fail the event stage when the DM stage throws", async () => {
    mockConsultationFindMany.mockRejectedValue(new Error("db down"));

    const result = await expireEventChannels();

    expect(result.errors.some((e) => e.includes("dm stage"))).toBe(true);
    // The event stage's own counters survive; the caller reports them.
    expect(result.frozen).toBe(0);
  });
});

describe("channel expiry provider outcomes", () => {
  it("treats confirmed missing lazy event and DM channels as absence without stamping their ledgers", async () => {
    mockAppointmentFindMany.mockResolvedValue([
      {
        webinar: {
          id: "lazy-event",
          chatFrozenAt: null,
          webinarPlan: { id: "plan", collaborators: [], organization: null },
        },
        class: null,
        organization: null,
        occurrences: [{ endsAt: daysAgo(14) }],
      },
    ]);
    mockConsultationFindMany.mockResolvedValue([consultation("lazy-dm", 120)]);
    mockUpdatePartial.mockRejectedValue(
      Object.assign(new Error("Resource not found"), { status: 404, code: 16 }),
    );
    const result = await expireEventChannels();
    expect(result).toMatchObject({
      success: true,
      missingChannels: 2,
      frozen: 0,
      dmFrozen: 0,
      errors: [],
    });
    expect(mockConsultationUpdateMany).not.toHaveBeenCalled();
    expect(mockSubscriptionUpdateMany).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  const channelsNotFound = () =>
    Object.assign(new Error("DeleteChannels failed: channels not found"), {
      status: 404,
      code: 16,
    });

  it("counts an already-deleted DM as missing instead of failing the run", async () => {
    mockConsultationFindMany.mockResolvedValue([consultation("gone", 400)]);
    mockDeleteChannels.mockRejectedValueOnce(channelsNotFound());

    const result = await expireEventChannels();

    expect(result).toMatchObject({
      success: true,
      missingChannels: 1,
      dmDeleteRequests: 0,
      errors: [],
    });
    expect(mockDeleteChannels).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  const pastRetentionWebinar = (id: string) => ({
    webinar: {
      id,
      chatFrozenAt: null,
      webinarPlan: { id: `plan-${id}`, collaborators: [], organization: null },
    },
    class: null,
    organization: null,
    occurrences: [{ endsAt: daysAgo(400) }],
  });

  it("deletes only the event channels Stream still has when a batch names a gone one", async () => {
    mockAppointmentFindMany.mockResolvedValue([
      pastRetentionWebinar("kept-webinar"),
      pastRetentionWebinar("gone-webinar"),
    ]);
    mockDeleteChannels.mockRejectedValueOnce(channelsNotFound());
    mockQueryChannels.mockImplementation(
      async (filter: { cid: { $in: string[] } }) =>
        filter.cid.$in.slice(0, 1).map((cid) => ({ cid })),
    );

    const result = await expireEventChannels();

    const [firstBatch] = mockDeleteChannels.mock.calls[0] as [string[]];
    expect(firstBatch).toHaveLength(2);
    expect(mockDeleteChannels).toHaveBeenCalledTimes(2);
    expect(mockDeleteChannels.mock.calls[1]).toEqual([
      [firstBatch[0]],
      { hard_delete: true },
    ]);
    expect(result).toMatchObject({
      success: true,
      deleted: 1,
      missingChannels: 1,
      errors: [],
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("counts channels deleted between the lookup and the retry as missing", async () => {
    mockAppointmentFindMany.mockResolvedValue([
      pastRetentionWebinar("raced-webinar"),
    ]);
    mockDeleteChannels
      .mockRejectedValueOnce(channelsNotFound())
      .mockRejectedValueOnce(channelsNotFound());
    mockQueryChannels.mockImplementation(
      async (filter: { cid: { $in: string[] } }) =>
        filter.cid.$in.map((cid) => ({ cid })),
    );

    const result = await expireEventChannels();

    expect(mockDeleteChannels).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: true,
      deleted: 0,
      missingChannels: 1,
      errors: [],
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it.each([429, 500])(
    "fails truthfully for HTTP %i and captures once across both vendor and sweep catches",
    async (status) => {
      mockConsultationFindMany.mockResolvedValue(
        ["a", "b", "c"].map((id) => ({
          ...consultation(id, 120),
          requestedBy: { user: { id: `client-${id}` } },
        })),
      );
      mockUpdatePartial.mockImplementation(async () => {
        throw Object.assign(new Error("provider refused update"), { status });
      });
      const result = await expireEventChannels();
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(3);
      expect(result.missingChannels).toBe(0);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          extra: expect.objectContaining({ count: 3 }),
        }),
      );
    },
  );
});

it("does not lift the freeze of a deactivated organization", async () => {
  mockOrganizationFindMany.mockResolvedValue([
    {
      id: "org-1",
      chatRetentionDays: 365,
      status: "DEACTIVATED",
      deletedAt: null,
    },
  ]);
  mockConsultationFindMany.mockResolvedValue([
    consultation("c", 3, daysAgo(100), "org-1"),
  ]);
  expect((await expireEventChannels()).dmUnfrozen).toBe(0);
  expect(mockUpdatePartial).not.toHaveBeenCalled();
});

it("re-freezes instead of clearing the ledger when wind-down commits during unfreeze", async () => {
  mockOrganizationFindMany
    .mockResolvedValueOnce([
      {
        id: "org-1",
        chatRetentionDays: 365,
        status: "ACTIVE",
        deletedAt: null,
      },
    ])
    .mockResolvedValueOnce([{ id: "org-1" }]);
  mockConsultationFindMany.mockResolvedValue([
    consultation("c", 3, daysAgo(100), "org-1"),
  ]);
  const result = await expireEventChannels();
  expect(result).toMatchObject({ success: true, dmUnfrozen: 0, dmFrozen: 1 });
  expect(mockUpdatePartial.mock.calls.map(([arg]) => arg.set.frozen)).toEqual([
    false,
    true,
  ]);
  expect(
    mockConsultationUpdateMany.mock.calls.every(
      ([arg]) => arg.data.chatFrozenAt !== null,
    ),
  ).toBe(true);
});

it("pages mixed-case channel identities in code-unit order without losing the tail", async () => {
  const ids = [
    ...Array.from({ length: 12 }, (_, i) => `a${i}`),
    ...Array.from({ length: 12 }, (_, i) => `Z${i}`),
  ];
  mockConsultationFindMany.mockResolvedValue(
    ids.map((id) => {
      const row = consultation(id, 120);
      row.consultationPlan.consultantProfile.user.id = id;
      return row;
    }),
  );
  let total = 0;
  for (let run = 0; run < 3; run++) {
    const result = await expireEventChannels();
    total += result.dmFrozen;
    jest.mocked(readJobCheckpoint).mockResolvedValue(result.checkpoint);
  }
  expect(total).toBe(24);
  expect(new Set(mockChannel.mock.calls.map((call) => call[1])).size).toBe(24);
});

it("unfreezes every returning pair in one run, beyond the freeze cursor slice", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `back${i}`);
  mockConsultationFindMany.mockResolvedValue(
    ids.map((id) => {
      const row = consultation(id, 3, daysAgo(30));
      row.consultationPlan.consultantProfile.user.id = id;
      return row;
    }),
  );
  const result = await expireEventChannels();
  expect(result.dmUnfrozen).toBe(12);
  expect(mockUpdatePartial).toHaveBeenCalledTimes(12);
  expect(mockUpdatePartial).toHaveBeenCalledWith({ set: { frozen: false } });
});

function endedWebinarPage(frozen: boolean) {
  return [
    {
      id: "appointment-old",
      webinar: {
        id: "old",
        chatFrozenAt: frozen ? daysAgo(1) : null,
        webinarPlan: {
          id: "plan",
          collaborators: [{ id: "presenter" }],
          organization: null,
        },
      },
      class: null,
      organization: null,
      occurrences: [{ endsAt: daysAgo(100) }],
    },
  ];
}
it("uses a newer past event outside the appointment page to protect the shared collaborator channel", async () => {
  mockAppointmentFindMany.mockResolvedValue(endedWebinarPage(true));
  mockLatestOccurrence.mockResolvedValue({ endsAt: daysAgo(2) });
  await expireEventChannels();
  expect(mockLatestOccurrence.mock.calls[0][0]).toMatchObject({
    orderBy: { endsAt: "desc" },
    select: { endsAt: true },
  });
  expect(mockLatestOccurrence.mock.calls[0][0].where.endsAt).toBeUndefined();
  expect(mockDeleteChannels).toHaveBeenCalledTimes(1);
  expect(mockDeleteChannels.mock.calls[0][0]).toEqual(["team:webinar-old"]);
  expect(
    mockChannel.mock.calls.some((call) =>
      String(call[1]).startsWith("collab-"),
    ),
  ).toBe(false);
});
it("does not infer collaborator freeze success from frozen event ledgers", async () => {
  mockAppointmentFindMany.mockResolvedValue(endedWebinarPage(true));
  mockLatestOccurrence.mockResolvedValue({ endsAt: daysAgo(10) });
  await expireEventChannels();
  expect(mockUpdatePartial).toHaveBeenCalledWith({ set: { frozen: true } });
  expect(
    mockChannel.mock.calls.some((call) =>
      String(call[1]).startsWith("collab-"),
    ),
  ).toBe(true);
});
