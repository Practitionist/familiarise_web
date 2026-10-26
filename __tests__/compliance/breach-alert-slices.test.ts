/** @jest-environment node */
import { Prisma } from "@prisma/client";

const recipientQueries: Prisma.Sql[] = [];
type Recipient = { id: string; email: string };
type EmailRow = {
  id: string;
  entityRef: string;
  recipient: string;
  status: string;
};
let users: Recipient[] = [],
  emails: EmailRow[] = [],
  notices: string[] = [];
const stageEmail = jest.fn(),
  notify = jest.fn(),
  page = jest.fn(),
  chat = jest.fn(),
  markDigest = jest.fn(),
  findBreaches = jest.fn(),
  findUser = jest.fn(),
  runTransaction = jest.fn();
const tx = {
  user: {
    findFirst: async (q: {
      where: { id?: string; email?: string | { equals: string } };
    }) =>
      users.find((u) =>
        q.where.id
          ? u.id === q.where.id && u.email === q.where.email
          : u.email.toLowerCase() ===
            (typeof q.where.email === "string"
              ? q.where.email
              : q.where.email?.equals
            )?.toLowerCase(),
      ) ?? null,
  },
};
const firstEmail = async (q: {
  where: { entityRef: string | { startsWith: string }; recipient?: string };
}) =>
  emails.find(
    (r) =>
      (typeof q.where.entityRef === "string"
        ? r.entityRef === q.where.entityRef
        : r.entityRef.startsWith(q.where.entityRef.startsWith)) &&
      (!q.where.recipient || r.recipient === q.where.recipient),
  ) ?? null;
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: async (q: Prisma.Sql) => {
      recipientQueries.push(q);
      const ref = q.values.find(
        (v) =>
          typeof v === "string" &&
          v.startsWith("compliance:databreach-deadline:active:"),
      );
      const limit = q.values[q.values.length - 1];
      return users
        .filter(
          (u) =>
            u.email.trim() &&
            !emails.some((e) => e.entityRef === ref && e.recipient === u.email),
        )
        .slice(0, typeof limit === "number" ? limit : 0);
    },
    failedEmail: {
      findFirst: (q: Parameters<typeof firstEmail>[0]) => firstEmail(q),
      updateMany: (q: {
        where: { entityRef: string };
        data: { entityRef: string };
      }) => markDigest(q),
    },
    user: {
      findFirst: (q: Parameters<typeof tx.user.findFirst>[0]) => findUser(q),
    },
    dataBreach: { findMany: (...a: unknown[]) => findBreaches(...a) },
    $transaction: (run: (value: typeof tx) => Promise<unknown>) =>
      runTransaction(run),
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, run: () => Promise<unknown>) =>
    run(),
}));
jest.mock("../../lib/email/deliver", () => ({
  stage: (...args: unknown[]) => stageEmail(...args),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyComplianceAlert: (...args: unknown[]) => notify(...args),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: (...args: unknown[]) => page(...args),
}));
jest.mock("../../lib/observability/ops-chat", () => ({
  postOpsChat: (...args: unknown[]) => chat(...args),
}));
jest.mock("../../lib/url", () => ({ getAppUrl: () => "https://test.invalid" }));
import { runDataBreachDeadlineAlerts } from "../../lib/compliance/databreach-deadline-alerts";
const original = process.env.DATABREACH_ALERT_EMAIL;
beforeEach(() => {
  jest.clearAllMocks();
  recipientQueries.length = 0;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-10-23T01:00:00Z"));
  delete process.env.DATABREACH_ALERT_EMAIL;
  users = Array.from({ length: 25 }, (_, i) => ({
    id: String(i).padStart(2, "0"),
    email: `admin${i}@example.test`,
  }));
  emails = [];
  notices = [];
  findBreaches.mockResolvedValue([
    { id: "breach", detectedAt: new Date(Date.now() - 70 * 3600000) },
  ]);
  findUser.mockImplementation((q: Parameters<typeof tx.user.findFirst>[0]) =>
    tx.user.findFirst(q),
  );
  markDigest.mockImplementation(
    async (q: {
      where: { entityRef: string };
      data: { entityRef: string };
    }) => {
      let count = 0;
      for (const row of emails)
        if (row.entityRef === q.where.entityRef) {
          row.entityRef = q.data.entityRef;
          count++;
        }
      return { count };
    },
  );
  runTransaction.mockImplementation(
    async (run: (value: typeof tx) => Promise<unknown>) => {
      const before = emails.map((r) => ({ ...r })),
        beforeNotices = [...notices];
      try {
        return await run(tx);
      } catch (error) {
        emails = before;
        notices = beforeNotices;
        throw error;
      }
    },
  );
  notify.mockImplementation(async (id: string) => {
    notices.push(id);
  });
  chat.mockResolvedValue(true);
  stageEmail.mockImplementation(
    async (
      message: { to: string },
      _type: string,
      opts: { entityRef: string },
    ) => {
      const id = String(emails.length);
      emails.push({
        id,
        entityRef: opts.entityRef,
        recipient: message.to,
        status: "PENDING",
      });
      return { id };
    },
  );
});
afterEach(() => jest.useRealTimers());
afterAll(() => {
  if (original === undefined) delete process.env.DATABREACH_ALERT_EMAIL;
  else process.env.DATABREACH_ALERT_EMAIL = original;
});
it("stages25recipients over three invocations and deduplicates the completed hour", async () => {
  const results = [];
  for (let i = 0; i < 3; i++)
    results.push(await runDataBreachDeadlineAlerts({ limit: 10 }));
  expect(results.map((r) => r.recipientsStaged)).toEqual([10, 10, 5]);
  expect(results.map((r) => r.hasMore)).toEqual([true, true, false]);
  expect(new Set(emails.map((e) => e.recipient)).size).toBe(25);
  expect(emails).toHaveLength(25);
  expect(
    (await runDataBreachDeadlineAlerts({ limit: 10 })).recipientsStaged,
  ).toBe(0);
  expect(emails).toHaveLength(25);
});
it("finishes an older digest across an hour boundary before starting the new hour", async () => {
  await runDataBreachDeadlineAlerts({ limit: 10 });
  jest.setSystemTime(new Date("2026-10-23T02:00:00Z"));
  const second = await runDataBreachDeadlineAlerts({ limit: 10 }),
    third = await runDataBreachDeadlineAlerts({ limit: 10 });
  expect(second.windowStart).toBe("2026-10-23T01:00:00.000Z");
  expect(third.recipientsStaged).toBe(5);
  expect(
    emails.every((e) => e.entityRef.includes("complete:2026-10-23T01:00")),
  ).toBe(true);
  expect((await runDataBreachDeadlineAlerts({ limit: 10 })).windowStart).toBe(
    "2026-10-23T02:00:00.000Z",
  );
});
it("rolls back notification staging when email staging fails and retries the missing recipient", async () => {
  users = users.slice(0, 2);
  stageEmail.mockRejectedValueOnce(new Error("staging unavailable"));
  const result = await runDataBreachDeadlineAlerts({ limit: 10 });
  expect(result.success).toBe(false);
  expect(page).toHaveBeenCalledTimes(1);
  expect(notices).toEqual(["01"]);
  expect(emails).toHaveLength(1);
  const retry = await runDataBreachDeadlineAlerts({ limit: 10 });
  expect(retry.recipientsStaged).toBe(1);
  expect(new Set(notices)).toEqual(new Set(["00", "01"]));
  expect(emails).toHaveLength(2);
});

it("reports an invalid optional officer address while preserving admin staging and the unfinished digest", async () => {
  users = users.slice(0, 2);
  process.env.DATABREACH_ALERT_EMAIL = "invalid-officer-address";
  const first = await runDataBreachDeadlineAlerts({ limit: 10 });
  expect(first.success).toBe(false);
  expect(first.errors).toEqual([
    "DATABREACH_ALERT_EMAIL is not a valid email address",
  ]);
  expect(first.recipientsStaged).toBe(2);
  expect(first.officerStaged).toBe(false);
  expect(first.hasMore).toBe(true);
  expect(notices).toHaveLength(2);
  expect(emails).toHaveLength(2);
  expect(emails.every((row) => row.entityRef.includes(":active:"))).toBe(true);
  expect(page).toHaveBeenCalledTimes(1);

  process.env.DATABREACH_ALERT_EMAIL = "officer@example.test";
  const retry = await runDataBreachDeadlineAlerts({ limit: 10 });
  expect(retry.success).toBe(true);
  expect(retry.recipientsStaged).toBe(0);
  expect(retry.officerStaged).toBe(true);
  expect(emails).toHaveLength(3);
  expect(notices).toHaveLength(2);
  expect(emails.every((row) => row.entityRef.includes(":complete:"))).toBe(
    true,
  );
});
it("counts guarded held mail as persisted progress and excludes missing addresses", async () => {
  users[0].email = "";
  const base = stageEmail.getMockImplementation();
  stageEmail.mockImplementation(async (...args: unknown[]) => {
    const staged = await base?.(...args);
    emails[emails.length - 1].status = "DEAD_LETTER";
    return { ...staged, held: true };
  });
  for (let i = 0; i < 3; i++) await runDataBreachDeadlineAlerts({ limit: 10 });
  expect(emails).toHaveLength(24);
  expect(emails.every((e) => e.status === "DEAD_LETTER")).toBe(true);
  expect(notices).not.toContain("00");
});
it("does not mark an empty staging result complete or retain a notification without its email", async () => {
  users = users.slice(0, 1);
  stageEmail.mockResolvedValue(null);
  const result = await runDataBreachDeadlineAlerts();
  expect(result.success).toBe(false);
  expect(result.hasMore).toBe(true);
  expect(notices).toEqual([]);
  expect(emails).toEqual([]);
});
it("does not start a cohort after the server work budget is already spent", async () => {
  const result = await runDataBreachDeadlineAlerts({
    startedAt: Date.now() - 20000,
  });
  expect(result.deadlineReached).toBe(true);
  expect(stageEmail).not.toHaveBeenCalled();
  expect(result.success).toBe(false);
});

it("does not archive an active digest when the empty candidate read uses the remaining budget", async () => {
  const activeRef =
    "compliance:databreach-deadline:active:2026-10-23T01:00:00.000Z";
  emails = [
    {
      id: "existing",
      entityRef: activeRef,
      recipient: "admin@example.test",
      status: "PENDING",
    },
  ];
  findBreaches.mockImplementationOnce(async () => {
    jest.advanceTimersByTime(16_000);
    return [];
  });

  const result = await runDataBreachDeadlineAlerts({ startedAt: Date.now() });

  expect(result).toMatchObject({ deadlineReached: true, hasMore: true });
  expect(markDigest).not.toHaveBeenCalled();
  expect(emails[0].entityRef).toBe(activeRef);
});

it("leaves a fully staged digest active when the ops notice consumes the remaining budget", async () => {
  users = users.slice(0, 1);
  chat.mockImplementationOnce(async () => {
    jest.advanceTimersByTime(16_000);
    return true;
  });

  const first = await runDataBreachDeadlineAlerts({ startedAt: Date.now() });

  expect(first).toMatchObject({ deadlineReached: true, hasMore: true });
  expect(markDigest).not.toHaveBeenCalled();
  expect(emails).toHaveLength(1);
  expect(emails[0].entityRef).toContain(":active:");

  const resumed = await runDataBreachDeadlineAlerts({ startedAt: Date.now() });

  expect(resumed.success).toBe(true);
  expect(markDigest).toHaveBeenCalledTimes(1);
  expect(emails[0].entityRef).toContain(":complete:");
});

it("does not start configured officer mail after preliminary reads exhaust the budget", async () => {
  users = [];
  process.env.DATABREACH_ALERT_EMAIL = "officer@example.test";
  findUser.mockImplementationOnce(async () => {
    jest.advanceTimersByTime(16_000);
    return null;
  });

  const result = await runDataBreachDeadlineAlerts({ startedAt: Date.now() });

  expect(result).toMatchObject({ deadlineReached: true, hasMore: true });
  expect(runTransaction).not.toHaveBeenCalled();
  expect(stageEmail).not.toHaveBeenCalled();
  expect(markDigest).not.toHaveBeenCalled();
});

it("stages a configured officer mailbox without a user and detects empty persistence", async () => {
  users = [];
  process.env.DATABREACH_ALERT_EMAIL = "officer@example.test";
  expect(await runDataBreachDeadlineAlerts()).toMatchObject({
    success: true,
    officerStaged: true,
  });
  expect(emails).toHaveLength(1);
  expect(notices).toEqual([]);
  emails = [];
  stageEmail.mockResolvedValue(null);
  expect(await runDataBreachDeadlineAlerts()).toMatchObject({
    success: false,
    hasMore: true,
    officerStaged: false,
  });
});

it("queries the physical user table declared by Prisma when selecting breach recipients", async () => {
  users = users.slice(0, 1);
  await runDataBreachDeadlineAlerts();
  const userModel = Prisma.dmmf.datamodel.models.find(
    (model) => model.name === Prisma.ModelName.User,
  );
  expect(userModel).toBeDefined();
  expect(recipientQueries.length).toBeGreaterThan(0);
  expect(
    recipientQueries.map((query) => query.text.match(/FROM "([^"]+)" u/)?.[1]),
  ).toEqual(recipientQueries.map(() => userModel?.dbName ?? userModel?.name));
});
