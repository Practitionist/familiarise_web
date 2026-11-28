/**
 * The database's arbitration of an expert's time: the atoms a set of windows
 * maps to, the order they are taken in, and the refusal when one is held.
 */
import {
  lockHostTimeInTx,
  type HeldHostTime,
} from "@/lib/booking/allocation/host-time-locks";
import { learnerTimeKeys, slotBatchKeys } from "@/utils/appointmentlock";

jest.mock("@/lib/redis", () => ({
  __esModule: true,
  default: {},
  withCircuitBreaker: jest.fn(),
  checkRedisHealth: jest.fn(),
}));

const HOST = "cp_host";
const COHOST = "cp_cohost";

function txReturning(rows: Array<{ i: number }>) {
  const $queryRaw = jest.fn(
    async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows,
  );
  return { tx: { $queryRaw } as never, $queryRaw };
}

const refusal = (held: HeldHostTime) =>
  Object.assign(new Error("taken"), { held });

describe("the atoms a window maps to", () => {
  it("maps a 45-minute and a 90-minute session to every half-hour they touch", () => {
    expect(
      slotBatchKeys([
        {
          consultantProfileId: HOST,
          startsAt: "2027-03-01T10:00:00.000Z",
          endsAt: "2027-03-01T10:45:00.000Z",
        },
      ]),
    ).toEqual([
      `slot-booking:${HOST}:2027-03-01T10:00:00.000Z`,
      `slot-booking:${HOST}:2027-03-01T10:30:00.000Z`,
    ]);
    expect(
      slotBatchKeys([
        {
          consultantProfileId: HOST,
          startsAt: "2027-03-01T10:00:00.000Z",
          endsAt: "2027-03-01T11:30:00.000Z",
        },
      ]),
    ).toHaveLength(3);
  });

  it("collides an off-grid window with the aligned sessions on either side of it", () => {
    const offGrid = slotBatchKeys([
      {
        consultantProfileId: HOST,
        startsAt: "2027-03-01T10:15:00.000Z",
        endsAt: "2027-03-01T10:45:00.000Z",
      },
    ]);
    expect(offGrid).toEqual([
      `slot-booking:${HOST}:2027-03-01T10:00:00.000Z`,
      `slot-booking:${HOST}:2027-03-01T10:30:00.000Z`,
    ]);
  });

  it("derives atoms from instants: one session written in two zones, across midnight, is one key set", () => {
    const utc = slotBatchKeys([
      {
        consultantProfileId: HOST,
        startsAt: "2027-03-01T18:15:00.000Z",
        endsAt: "2027-03-01T19:15:00.000Z",
      },
    ]);
    const kolkataAcrossMidnight = slotBatchKeys([
      {
        consultantProfileId: HOST,
        startsAt: "2027-03-01T23:45:00+05:30",
        endsAt: "2027-03-02T00:45:00+05:30",
      },
    ]);
    expect(kolkataAcrossMidnight).toEqual(utc);
    expect(utc).toHaveLength(3);
  });

  it("gives a co-host their own atoms for the same window, in one sorted list", () => {
    const window = {
      startsAt: "2027-03-01T10:00:00.000Z",
      endsAt: "2027-03-01T10:30:00.000Z",
    };
    expect(
      slotBatchKeys([
        { consultantProfileId: HOST, ...window },
        { consultantProfileId: COHOST, ...window },
        { consultantProfileId: HOST, ...window },
      ]),
    ).toEqual([
      `slot-booking:${COHOST}:2027-03-01T10:00:00.000Z`,
      `slot-booking:${HOST}:2027-03-01T10:00:00.000Z`,
    ]);
  });
});

describe("lockHostTimeInTx", () => {
  const entries = [
    {
      consultantProfileId: HOST,
      startsAt: "2027-03-01T10:00:00.000Z",
      endsAt: "2027-03-01T11:00:00.000Z",
    },
  ];

  it("takes every atom in one try-lock statement, in sorted order, and never a waiting lock", async () => {
    const { tx, $queryRaw } = txReturning([]);
    await lockHostTimeInTx(tx, entries, refusal);
    expect($queryRaw).toHaveBeenCalledTimes(1);
    const [strings, keys] = $queryRaw.mock.calls[0];
    const sql = strings.join("?");
    expect(sql).toContain("pg_try_advisory_xact_lock(");
    expect(sql).not.toMatch(/pg_advisory_xact_lock\(/);
    expect(keys).toEqual(slotBatchKeys(entries));
  });

  it("throws the door's own refusal, naming the held half-hour", async () => {
    const { tx } = txReturning([{ i: 2 }]);
    await expect(lockHostTimeInTx(tx, entries, refusal)).rejects.toMatchObject({
      message: "taken",
      held: {
        consultantProfileId: HOST,
        startsAt: new Date("2027-03-01T10:30:00.000Z"),
        endsAt: new Date("2027-03-01T11:00:00.000Z"),
      },
    });
  });

  it("runs no statement for a write that makes no time busy", async () => {
    const { tx, $queryRaw } = txReturning([]);
    await lockHostTimeInTx(tx, [], refusal);
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

describe("a learner's own time in a 1:1", () => {
  const LEARNER = "user_learner";
  const hostEntries = [
    {
      consultantProfileId: HOST,
      startsAt: "2027-03-01T10:15:00.000Z",
      endsAt: "2027-03-01T10:45:00.000Z",
    },
  ];
  const learnerTimes = [
    {
      userId: LEARNER,
      startsAt: "2027-03-01T10:15:00.000Z",
      endsAt: "2027-03-01T10:45:00.000Z",
    },
  ];

  it("maps to one atom per half-hour, keyed by the learner's user id, whoever the expert is", () => {
    expect(learnerTimeKeys(learnerTimes)).toEqual([
      `learner-time:${LEARNER}:2027-03-01T10:00:00.000Z`,
      `learner-time:${LEARNER}:2027-03-01T10:30:00.000Z`,
    ]);
  });

  it("is taken in the same statement as the expert's atoms, one sorted list", async () => {
    const { tx, $queryRaw } = txReturning([]);
    await lockHostTimeInTx(tx, hostEntries, refusal, learnerTimes);
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect($queryRaw.mock.calls[0][1]).toEqual([
      ...learnerTimeKeys(learnerTimes),
      ...slotBatchKeys(hostEntries),
    ]);
  });

  it("a held learner atom names the learner, not an expert", async () => {
    const { tx } = txReturning([{ i: 1 }]);
    await expect(
      lockHostTimeInTx(tx, hostEntries, refusal, learnerTimes),
    ).rejects.toMatchObject({
      held: {
        learnerUserId: LEARNER,
        consultantProfileId: null,
        startsAt: new Date("2027-03-01T10:00:00.000Z"),
      },
    });
  });
});
