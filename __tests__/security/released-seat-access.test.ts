/**
 * @jest-environment node
 */

/** A released seat (REFUNDED/CANCELLED) no longer lists an appointment's documents or recordings. */

import { ParticipantStatus } from "@prisma/client";
import { listDocumentsScoped } from "@/lib/api/scope/list-documents";
import { listRecordingsScoped } from "@/lib/api/scope/list-recordings";
import {
  liveParticipant,
  NOT_COLLABORATOR_ROW,
  paidParticipant,
} from "@/lib/booking/participants";
import { matchesWhere } from "../fixtures/mem-db";

const mockFindMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (ops: unknown[]) => Promise.all(ops),
    appointmentDocument: {
      count: async () => 0,
      findMany: (args: unknown) => mockFindMany(args),
    },
    recording: {
      count: async () => 0,
      findMany: (args: unknown) => mockFindMany(args),
    },
  },
}));

const USER = "user-1";

beforeEach(() => mockFindMany.mockReset().mockResolvedValue([]));

/** A live seat that is not a collaborator's own old row. */
const LIVE_SEAT = { ...liveParticipant(USER), ...NOT_COLLABORATOR_ROW };

function participantArm(appointmentWhere: { OR?: object[] }) {
  return appointmentWhere.OR?.find((arm) => "participants" in arm);
}

describe("released seats lose document and recording listings", () => {
  it("documents: the participant arm is a live seat of the user", async () => {
    await listDocumentsScoped({ scope: { kind: "personal" }, userId: USER });
    const arm = participantArm(mockFindMany.mock.calls[0][0].where.appointment);
    expect(arm).toEqual({ participants: { some: LIVE_SEAT } });
  });

  it("recordings: the participant arm is a live seat of the user", async () => {
    await listRecordingsScoped({ scope: { kind: "personal" }, userId: USER });
    const arm = participantArm(
      mockFindMany.mock.calls[0][0].where.meeting.occurrence.appointment,
    );
    expect(arm).toEqual({ participants: { some: LIVE_SEAT } });
  });

  it("a seat that left and rejoined lists them again; while left it does not", () => {
    const rejoined = {
      userId: USER,
      status: "CONFIRMED",
      removedByUserId: null,
      paymentId: "pay-free",
      payment: { paymentStatus: "SUCCEEDED" },
    };
    expect(matchesWhere(rejoined, liveParticipant(USER))).toBe(true);
    expect(matchesWhere(rejoined, paidParticipant(USER))).toBe(true);
    const left = { ...rejoined, status: "CANCELLED" };
    expect(matchesWhere(left, liveParticipant(USER))).toBe(false);
    expect(matchesWhere(left, paidParticipant(USER))).toBe(false);
  });

  it("liveParticipant admits live seats and excludes released ones", () => {
    const { status } = liveParticipant(USER);
    expect(status).toEqual({
      in: expect.arrayContaining([
        ParticipantStatus.HELD,
        ParticipantStatus.CONFIRMED,
        ParticipantStatus.ATTENDED,
      ]),
    });
    for (const released of [
      ParticipantStatus.REFUNDED,
      ParticipantStatus.CANCELLED,
    ]) {
      expect(status).not.toEqual({ in: expect.arrayContaining([released]) });
    }
  });
});
