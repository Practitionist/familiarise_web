/**
 * Every writer that makes an expert's time busy takes the database's try-locks
 * as the first statement of its write transaction, and maps a held atom to the
 * slot-taken answer its door already gives.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ConsultantScheduleConflictError } from "@/lib/collaborators/availability";
import {
  HostTimeHeldError,
  lockHostBatchInTx,
} from "@/lib/booking/host-slot-batch";
import {
  AllocationRaceError,
  SlotsTakenError,
  lockAllocationTimesInTx,
} from "@/lib/booking/allocation/slot-batch";
import {
  TrialTimeRefusedError,
  lockTrialPickInTx,
} from "@/lib/trials/book-trial";
import { slotBatchKeys, slotGrantEntries } from "@/utils/appointmentlock";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/redis", () => ({
  __esModule: true,
  default: {},
  withCircuitBreaker: jest.fn(),
  checkRedisHealth: jest.fn(),
}));

const ROOT = join(__dirname, "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** Each host-time writer: its file, the lock call it makes, and how many transactions make it. */
const WRITERS: ReadonlyArray<[file: string, call: string, sites: number]> = [
  ["lib/booking/allocation/modes/auto.ts", "lockAllocationTimesInTx(", 1],
  ["lib/booking/allocation/modes/manual.ts", "lockAllocationTimesInTx(", 1],
  [
    "lib/booking/allocation/modes/use-requested.ts",
    "lockAllocationTimesInTx(",
    1,
  ],
  ["app/api/scheduling/request-for-approval/route.ts", "lockHostTimeInTx(", 1],
  ["app/api/trials/route.ts", "lockTrialPickInTx(", 1],
  ["lib/booking/trial-reschedule.ts", "lockTrialPickInTx(", 1],
  ["lib/payments/checkout/commit/index.ts", "lockHostTimeInTx(", 1],
  ["lib/booking/incident-rebook.ts", "lockHostTimeInTx(", 1],
  [
    "app/api/bookings/webinars/crud-with-plan/route.ts",
    "lockHostBatchInTx(",
    2,
  ],
  ["app/api/bookings/classes/crud-with-plan/route.ts", "lockHostBatchInTx(", 2],
  ["lib/booking/event-retime.ts", "lockHostBatchInTx(", 1],
  ["lib/booking/class-retime.ts", "lockHostBatchInTx(", 1],
  ["lib/booking/class-sessions.ts", "lockHostBatchInTx(", 1],
  ["lib/collaborators/service.ts", "lockHostBatchInTx(", 1],
  ["app/api/meetings/[meetingId]/extend/route.ts", "lockHostBatchInTx(", 1],
];

/** Files that take or define the Redis slot batch without opening the write transaction themselves. */
const NOT_A_WRITE_TRANSACTION = new Set([
  // Definitions.
  "utils/appointmentlock.ts",
  "lib/booking/host-slot-batch.ts",
  "lib/booking/allocation/slot-batch.ts",
  "lib/trials/book-trial.ts",
  // Checkout takes its grants here; the commit takes the database's locks on them.
  "lib/payments/checkout/locks.ts",
]);

const REDIS_BATCH_CALL =
  /\b(?:lockSlotBatch|tryLockSlotBatch|lockSlotInterval|lockPickedSlots|withHostSlotBatch|lockTrialPick|lockBuyerSeatAtoms)\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
        ? [path]
        : [];
    },
  );
}

describe("host-time writers take the database's locks first", () => {
  it.each(WRITERS)("%s", (file, call, sites) => {
    const source = read(file);
    const calls = [
      ...source.matchAll(new RegExp(`await ${call.replace("(", "\\(")}`, "g")),
    ];
    expect(calls).toHaveLength(sites);
    for (const match of calls) {
      const before = source.slice(0, match.index);
      const opened = Math.max(
        before.lastIndexOf("(tx) =>"),
        before.lastIndexOf("(tx): Promise<"),
      );
      expect(opened).toBeGreaterThan(-1);
      // The lock call is the callback's first statement: no read, no row lock
      // and no Redis round trip runs inside the transaction ahead of it.
      const lead = before
        .slice(before.indexOf("{", opened) + 1)
        .replace(/^\s*\/\/.*$/gm, "");
      expect(lead.trim()).toBe("");
    }
  });

  it("lists every file that takes a Redis slot batch", () => {
    const listed = new Set(WRITERS.map(([file]) => file));
    const unlisted = ["app/api", "lib", "utils", "scripts"]
      .flatMap(sourceFiles)
      .filter((file) => REDIS_BATCH_CALL.test(read(file)))
      .filter(
        (file) =>
          !listed.has(file) &&
          !NOT_A_WRITE_TRANSACTION.has(file) &&
          // The orchestrator hands its grants to the commit.
          file !== "lib/payments/checkout/orchestrate.ts",
      );
    expect(unlisted).toEqual([]);
  });

  it.each(["auto", "manual", "use-requested"])(
    "allocator %s mode renews its Redis grants ahead of each attempt, never inside the transaction",
    (mode) => {
      const source = read(`lib/booking/allocation/modes/${mode}.ts`);
      const opened = source.indexOf("async (tx) =>");
      const lockCall = source.indexOf("await lockAllocationTimesInTx(");
      // The database's locks are the callback's first statement.
      expect(
        source.slice(source.indexOf("{", opened) + 1, lockCall).trim(),
      ).toBe("");
      const hook = source.slice(source.indexOf("beforeAttempt: async () => {"));
      expect(source.indexOf("beforeAttempt: async () => {")).toBeGreaterThan(
        lockCall,
      );
      expect(hook.slice(0, hook.indexOf("},"))).toMatch(
        /renewConsulteeBooking\(consulteeLock\);\s+await renewAllocationBatch\(slotGrant\);/,
      );
      expect(source.match(/renewAllocationBatch\(/g)).toHaveLength(1);
    },
  );

  it("hands the checkout commit the atoms of both of its grants", () => {
    const orchestrate = read("lib/payments/checkout/orchestrate.ts");
    expect(orchestrate).toContain("slotGrantEntries(lock)");
    expect(orchestrate).toContain("slotGrantEntries(buyerSeatGrant)");
  });
});

describe("a held atom is the door's own slot-taken answer", () => {
  const held = [{ i: 1 }];
  const tx = () => ({ $queryRaw: jest.fn(async () => held) }) as never;
  const start = new Date("2027-03-01T10:00:00.000Z");
  const end = new Date("2027-03-01T10:30:00.000Z");

  it("picked allocation times: TIMES_TAKEN naming the held time; auto mode passes its race", async () => {
    const refused = await lockAllocationTimesInTx(
      tx(),
      [start],
      ["cp_host"],
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SlotsTakenError);
    expect((refused as SlotsTakenError).takenSlotStarts).toEqual([
      start.toISOString(),
    ]);
    await expect(
      lockAllocationTimesInTx(
        tx(),
        [start],
        ["cp_host"],
        () => new AllocationRaceError(),
      ),
    ).rejects.toBeInstanceOf(AllocationRaceError);
  });

  it("host-time writers: the transient schedule conflict", async () => {
    const refused = await lockHostBatchInTx(tx(), [
      { consultantProfileId: "cp_host", startsAt: start, endsAt: end },
    ]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HostTimeHeldError);
    expect(refused).toBeInstanceOf(ConsultantScheduleConflictError);
  });

  it("the trial door: SLOT_TAKEN, over the host's atoms and an expert buyer's own", async () => {
    const $queryRaw = jest.fn(
      async (_strings: TemplateStringsArray, ..._values: unknown[]) => held,
    );
    const refused = await lockTrialPickInTx({ $queryRaw } as never, {
      consultantProfileId: "cp_host",
      buyerConsultantProfileId: "cp_buyer",
      startsAt: start,
      endsAt: end,
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TrialTimeRefusedError);
    expect((refused as TrialTimeRefusedError).code).toBe("SLOT_TAKEN");
    expect($queryRaw.mock.calls[0][1]).toEqual([
      `slot-booking:cp_buyer:${start.toISOString()}`,
      `slot-booking:cp_host:${start.toISOString()}`,
    ]);
  });

  it("a Redis grant maps back to the atoms it holds", () => {
    const entries = [
      {
        consultantProfileId: "cp_host",
        startsAt: start,
        endsAt: new Date("2027-03-01T11:00:00.000Z"),
      },
    ];
    const grant = slotBatchKeys(entries).map((key) => ({
      key,
      value: "v",
      ttl: 1,
      acquiredAt: 0,
      client: {} as never,
    }));
    expect(slotBatchKeys(slotGrantEntries(grant))).toEqual(
      slotBatchKeys(entries),
    );
  });
});
