/**
 * @jest-environment node
 */

/** A released seat (REFUNDED/CANCELLED) no longer lists an appointment's documents or recordings. */

import { ParticipantStatus } from "@prisma/client";
import { listDocumentsScoped } from "@/lib/api/scope/list-documents";
import { listRecordingsScoped } from "@/lib/api/scope/list-recordings";
import { liveParticipant } from "@/lib/booking/participants";

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

function participantArm(appointmentWhere: { OR?: object[] }) {
  return appointmentWhere.OR?.find((arm) => "participants" in arm);
}

describe("released seats lose document and recording listings", () => {
  it("documents: the participant arm is liveParticipant(userId)", async () => {
    await listDocumentsScoped({ scope: { kind: "personal" }, userId: USER });
    const arm = participantArm(mockFindMany.mock.calls[0][0].where.appointment);
    expect(arm).toEqual({ participants: { some: liveParticipant(USER) } });
  });

  it("recordings: the participant arm is liveParticipant(userId)", async () => {
    await listRecordingsScoped({ scope: { kind: "personal" }, userId: USER });
    const arm = participantArm(
      mockFindMany.mock.calls[0][0].where.meeting.occurrence.appointment,
    );
    expect(arm).toEqual({ participants: { some: liveParticipant(USER) } });
  });

  it("liveParticipant admits live seats and excludes released ones", () => {
    const { status } = liveParticipant(USER);
    expect(status).toEqual({
      in: expect.arrayContaining([ParticipantStatus.CONFIRMED]),
    });
    for (const released of [
      ParticipantStatus.REFUNDED,
      ParticipantStatus.CANCELLED,
    ]) {
      expect(status).not.toEqual({ in: expect.arrayContaining([released]) });
    }
  });
});
