/**
 * @jest-environment node
 */

/**
 * Defect 8 — two concurrent removals must refund one seat, not two.
 *
 * The participant DELETE endpoints read the attendee's slot links, checked
 * "did I find any", and only then disconnected them. Between the read and the
 * write anything could happen, and under a double click, a stale tab, or an
 * organiser removing someone who is leaving at the same moment, both requests
 * read a non-empty roster and both went on to call
 * `refundRemovedAttendeeSeat` — which resolves the payment by user + event and
 * so happily refunds the same seat twice.
 *
 * The read now lives inside a Serializable transaction with the write, so the
 * loser either finds the roster already empty or is aborted on the slot row it
 * also tried to touch and finds it empty on retry. Pinned here for both
 * webinars and classes: the empty-inside-the-transaction path returns
 * `{ removed: false }` and never reaches the refund.
 */

const mockRefundRemovedAttendeeSeat = jest.fn();
const mockRemoveUserFromEventChannel = jest.fn();
const mockFindLiveEventSlot = jest.fn();
const mockRequireApiAuth = jest.fn();

const mockWebinarFindFirst = jest.fn();
const mockClassFindFirst = jest.fn();
const mockParticipantUpdateMany = jest.fn();
const mockTransaction = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webinar: { findFirst: (...a: unknown[]) => mockWebinarFindFirst(...a) },
    class: { findFirst: (...a: unknown[]) => mockClassFindFirst(...a) },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...a: unknown[]) => mockRequireApiAuth(...a),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
  forbiddenResponse: (message: string) =>
    new Response(JSON.stringify({ error: message }), { status: 403 }),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
  participantReadLimiter: {},
}));

jest.mock("../../lib/payments/operations/event-refunds", () => ({
  __esModule: true,
  refundRemovedAttendeeSeat: (...a: unknown[]) =>
    mockRefundRemovedAttendeeSeat(...a),
}));

jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  __esModule: true,
  removeUserFromEventChannel: (...a: unknown[]) =>
    mockRemoveUserFromEventChannel(...a),
}));

jest.mock("../../lib/appointments/live-event-slot", () => ({
  __esModule: true,
  findLiveEventSlot: (...a: unknown[]) => mockFindLiveEventSlot(...a),
}));

import { Prisma } from "@prisma/client";
import { DELETE as deleteWebinarParticipant } from "../../app/api/participants/webinar/[webinarId]/route";
import { DELETE as deleteClassParticipant } from "../../app/api/participants/class/[classId]/route";

const ORGANISER = {
  id: "user-organiser",
  role: "CONSULTANT",
  consultantProfileId: "consultant-1",
};
const ATTENDEE_ID = "user-attendee";

/** Runs the interactive callback against a tx client backed by the seat mock. */
function runInteractiveTransaction(fn: unknown) {
  return (fn as (tx: unknown) => Promise<number>)({
    appointmentParticipant: {
      // #1780 — the seat is read on the tx first (its id keys the refund).
      findFirst: async () => ({
        id: "part-1",
        appointmentId: "apt-1",
        createdAt: new Date(0),
        refundWindowHours: null,
      }),
      updateMany: (...a: unknown[]) => mockParticipantUpdateMany(...a),
    },
  });
}

function serializationFailure() {
  return new Prisma.PrismaClientKnownRequestError(
    "could not serialize access due to concurrent update",
    { code: "P2034", clientVersion: "6.0.0" },
  );
}

/**
 * The two handlers differ only in the name of their route param, so the cases
 * are driven through one shape. Widened deliberately: keeping the two literal
 * param types would intersect across the table and satisfy neither.
 */
type ParticipantDelete = (
  request: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const CASES = [
  {
    label: "webinar",
    handler: deleteWebinarParticipant as unknown as ParticipantDelete,
    eventId: "webinar-1",
    participantScope: { webinarId: "webinar-1" },
    params: (): Promise<Record<string, string>> =>
      Promise.resolve({ webinarId: "webinar-1" }),
    findFirst: mockWebinarFindFirst,
  },
  {
    label: "class",
    handler: deleteClassParticipant as unknown as ParticipantDelete,
    eventId: "class-1",
    participantScope: { classId: "class-1" },
    params: (): Promise<Record<string, string>> =>
      Promise.resolve({ classId: "class-1" }),
    findFirst: mockClassFindFirst,
  },
] as const;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireApiAuth.mockResolvedValue({ session: { user: ORGANISER } });
  mockWebinarFindFirst.mockResolvedValue({ id: "webinar-1" });
  mockClassFindFirst.mockResolvedValue({ id: "class-1" });
  mockFindLiveEventSlot.mockResolvedValue(null);
  mockParticipantUpdateMany.mockResolvedValue({ count: 1 });
  // The real contract of refundRemovedAttendeeSeat — the roster client reads
  // all three fields to build the organiser's toast, so a stub of some invented
  // shape would freeze a response body the producer never returns.
  mockRefundRemovedAttendeeSeat.mockResolvedValue({
    amountRefundedPaise: 50_000,
    refundPct: 100,
    rail: "GATEWAY",
  });
  mockRemoveUserFromEventChannel.mockResolvedValue({ success: true });
  mockTransaction.mockImplementation((fn: unknown) =>
    runInteractiveTransaction(fn),
  );
});

describe.each(CASES)(
  "$label participant removal is single-writer (defect 8)",
  ({ handler, eventId, participantScope, params, findFirst }) => {
    function request() {
      return new Request(
        `http://localhost/api/participants?userId=${ATTENDEE_ID}`,
        { method: "DELETE" },
      );
    }

    it("releases inside the transaction and refuses to refund when the seat is already gone", async () => {
      // The rival removal committed between this request's auth check and its
      // write. #1554 — the seat IS the participant row, and the live-status CAS
      // in the WHERE matches zero rows for the loser.
      mockParticipantUpdateMany.mockResolvedValue({ count: 0 });

      const res = await handler(request(), { params: params() });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: false, refund: null });
      expect(mockRefundRemovedAttendeeSeat).not.toHaveBeenCalled();
      // Never mind the chat: nothing was released, so nothing is revoked.
      expect(mockRemoveUserFromEventChannel).not.toHaveBeenCalled();
    });

    it("runs the roster write at Serializable isolation", async () => {
      mockParticipantUpdateMany.mockResolvedValue({ count: 0 });

      await handler(request(), { params: params() });

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      // Budgets, not just the isolation level: a P2028 timeout is rethrown
      // rather than retried — 500, seat still held, fee not returned.
      expect(mockTransaction.mock.calls[0][1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      });
    });

    it("the winner releases the seat and refunds exactly once", async () => {
      mockParticipantUpdateMany.mockResolvedValue({ count: 1 });

      const res = await handler(request(), { params: params() });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        removed: true,
        refund: {
          amountRefundedPaise: 50_000,
          refundPct: 100,
          rail: "GATEWAY",
        },
      });
      // #1554 — one CAS statement: only a live seat flips, so the seat and
      // its history commit together or not at all.
      expect(mockParticipantUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockParticipantUpdateMany).toHaveBeenCalledWith({
        where: {
          appointment: participantScope,
          userId: ATTENDEE_ID,
          status: { in: ["HELD", "CONFIRMED", "ATTENDED"] },
        },
        data: { status: "CANCELLED" },
      });
      expect(mockRefundRemovedAttendeeSeat).toHaveBeenCalledTimes(1);
      expect(mockRefundRemovedAttendeeSeat).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId,
          attendeeUserId: ATTENDEE_ID,
          initiatedBy: "organiser",
        }),
      );
    });

    it("a serialization abort retries, and the retry sees the empty roster", async () => {
      // The database, not the application, is what separates the two writers:
      // the loser is aborted on the seat row it also tried to write. Its retry
      // must land on the no-op answer rather than a second refund.
      mockTransaction
        .mockImplementationOnce(() => Promise.reject(serializationFailure()))
        .mockImplementationOnce((fn: unknown) => runInteractiveTransaction(fn));
      mockParticipantUpdateMany.mockResolvedValue({ count: 0 });

      const res = await handler(request(), { params: params() });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: false, refund: null });
      expect(mockTransaction).toHaveBeenCalledTimes(2);
      expect(mockRefundRemovedAttendeeSeat).not.toHaveBeenCalled();
    });

    it("still 404s before any of this when the event is not the caller's", async () => {
      findFirst.mockResolvedValue(null);

      const res = await handler(request(), { params: params() });

      expect(res.status).toBe(404);
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  },
);
