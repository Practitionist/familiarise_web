import { standingRead } from "./expert-standing";

/** The transaction client an allocation of one 1:1 request writes through, with a verified expert. */
export function allocationTx() {
  return {
    $queryRaw: standingRead(),
    consultation: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    consultantProfile: {
      findFirst: jest.fn().mockResolvedValue({ id: "consultant-profile-1" }),
    },
    collaborator: { findMany: jest.fn().mockResolvedValue([]) },
    // Allocation records the participant edge and status history inside the CAS helpers.
    appointmentParticipant: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    appointment: {
      // The earnings-hold recompute reads the wrapper; none is paid here.
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      // No originating appointment, so the created rows carry no policy version.
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "apt-1", occurrences: [] }),
      update: jest.fn().mockResolvedValue({ id: "apt-1", occurrences: [] }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    appointmentOccurrence: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
}
