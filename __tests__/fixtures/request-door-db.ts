import { namedWeeklyWindow } from "./request-door-hours";

/** The expert as the request route reads them; read through a getter, so a case's edit is seen. */
export interface RequestDoorProfile {
  id: string;
  acceptingRequests: boolean;
  verificationStatus: string;
  deletedAt: Date | null;
  bookingMode: "REQUEST" | "INSTANT";
  maxOpenRequests: number | null;
  user: { id: string; name: string };
}

/** A verified expert who takes requests, with no open-request limit. */
export function requestDoorProfile(): RequestDoorProfile {
  return {
    id: "cp_1",
    acceptingRequests: true,
    verificationStatus: "VERIFIED",
    deletedAt: null,
    bookingMode: "REQUEST",
    maxOpenRequests: null,
    user: { id: "user_consultant", name: "Olivia" },
  };
}

/**
 * The Prisma client `POST /api/scheduling/request-for-approval` reads, for a
 * listed plan of `profile` and the open-request counts its cap compares.
 */
export function requestDoorDb(
  profileOf: () => RequestDoorProfile,
  counts: Record<
    "consultation" | "subscription" | "trial",
    (...args: unknown[]) => Promise<number>
  >,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const created = () => ({
    id: "req_1",
    requestedAt: new Date(),
    consultationPlan: { title: "Plan", consultantProfile: profileOf() },
    requestedBy: { user: { name: "Sam" } },
    appointment: { id: "apt_1", organizationId: null, occurrences: [] },
  });
  const db: Record<string, unknown> = {
    consulteeProfile: {
      findUnique: jest.fn(async () => ({ id: "cs_1", user: {} })),
    },
    consultantProfile: {
      findUnique: jest.fn(async () => ({
        bookingMode: profileOf().bookingMode,
      })),
    },
    availabilityWindowWeekly: namedWeeklyWindow,
    consultationPlan: {
      findFirst: jest.fn(async () => ({
        id: "plan_1",
        title: "Plan",
        consultantProfileId: profileOf().id,
        visibility: "PUBLIC",
        organizationId: null,
        archivedAt: null,
        consultantProfile: profileOf(),
      })),
    },
    consultation: {
      count: (...a: unknown[]) => counts.consultation(...a),
      create: jest.fn(async () => created()),
      findUnique: jest.fn(async () => null),
    },
    subscription: { count: (...a: unknown[]) => counts.subscription(...a) },
    trial: { count: (...a: unknown[]) => counts.trial(...a) },
    // The share-locked standing read answers with the profile's own facts.
    $queryRaw: jest.fn(async () => [
      {
        verificationStatus: profileOf().verificationStatus,
        deletedAt: profileOf().deletedAt,
      },
    ]),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    ...extra,
  };
  return db;
}
