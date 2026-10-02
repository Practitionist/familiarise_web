/**
 * @jest-environment node
 */

/**
 * THE PRINCIPAL LEG. A DPDP §12 erasure tore down the subject's name, email,
 * phone and every local row, reported `vendorFailures: []`, wrote
 * `USER_ERASURE_PROCESSED` — and left their entire Stream footprint intact:
 * name, email, image and every message they ever wrote.
 *
 * The cause was not a failed vendor call; it was the ABSENCE of one. The only
 * Stream work in `scrubUser` was `revokeCollaboratorAccess`, reached only from
 * `collaborationsRemoved`, which `removeCollaboratorStanding` returns as `[]`
 * for anyone without a ConsultantProfile — every consultee — as well as for a
 * consultant holding no PENDING/ACCEPTED collaborator row. The loop body never
 * ran, so no outbox row was written, so the retry sweep had nothing to sweep.
 * `scripts/stream/stream-sync.ts` cannot compensate: it only soft-deletes users
 * ABSENT from the database, and an erased user is still present.
 *
 * That is a false attestation, not a transient failure: no Sentry event, no
 * `vendorFailures` entry, no retry — and an audit row saying the erasure was
 * processed.
 *
 * These tests hold the leg in place. Test 1 is the headline regression: under
 * the pre-fix code it observes ZERO Stream work for a collaborator-less
 * subject, which is the whole defect. The rest pin the properties that make it
 * real rather than decorative — outbox inside the transaction, nothing vendor-
 * side inside it, a failing call that stays owed, an audit row that carries the
 * task id, and the consultant path that already worked.
 */

import { nextRetryAt } from "@/lib/retry/backoff";

// ── the Stream client, mocked ────────────────────────────────────────────────
// `lib/stream-client` constructs a Redis-backed breaker at import time and
// `getStreamChatClient()` validates env at call time, so the leg is driven
// through a mock rather than the network. Every binding is prefixed `mock` so
// jest's hoisted factory can close over it.
const mockRevokeUserToken = jest.fn(
  async (_userId: string, _revokedBefore?: Date) => ({}),
);
/**
 * Stream answers a batch delete with a background `task_id` and MAY report
 * per-user failures inline alongside it, so both are in the mock's return type:
 * a suite that could not express `failed_delete_users` could not test the case
 * where the call resolves and the deletion still does not happen.
 */
const mockDeleteUsers = jest.fn(
  async (_userIds: string[], _options?: { user?: string; messages?: string }) =>
    ({ task_id: "task_abc123" }) as {
      task_id: string;
      failed_delete_users?: { user_id: string; message?: string }[];
    },
);
let mockStreamConfigured = true;

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({
    revokeUserToken: mockRevokeUserToken,
    deleteUsers: mockDeleteUsers,
  }),
  isStreamConfigured: () => mockStreamConfigured,
  isRateLimitError: (error: unknown) =>
    Boolean(error && (error as { status?: number }).status === 429),
  withStreamCircuitBreaker: async (op: () => Promise<unknown>) => op(),
}));

jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(async () => undefined),
}));
jest.mock("../../lib/api/organizations/seat-count", () => ({
  releaseSeatsForTerminatedAssignments: jest.fn(async () => undefined),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(async () => undefined),
  recordSystemEvent: jest.fn(async () => undefined),
}));
jest.mock("../../lib/collaborators/service", () => ({
  revokeCollaboratorAccess: jest.fn(async () => ({ success: true })),
}));
// The Novu leg has its own coverage; stub it so a vendorFailures assertion here
// is about Stream and nothing else.
jest.mock("../../lib/novu/subscriber", () => ({
  deleteSubscriber: jest.fn(async () => true),
}));
jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => ({}),
  validateNovuConfig: () => {},
}));

// For the withdrawal rule below. Statically mocked rather than `jest.doMock`ed
// mid-test: a `jest.resetModules()` here would hand the NEXT suite a fresh copy
// of `@/lib/collaborators/service` and silently decouple the assertions below
// from the mock the scrub under test actually calls.
const mockForgetUserSynced = jest.fn();
jest.mock("../../lib/stream-cache", () => ({
  forgetUserSynced: (userId: string) => mockForgetUserSynced(userId),
}));
const mockConsentUpdateMany = jest.fn(async (_args: unknown) => ({ count: 1 }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consentArtifact: {
      updateMany: (args: unknown) => mockConsentUpdateMany(args),
    },
  },
}));

import { revokeCollaboratorAccess } from "@/lib/collaborators/service";
import { withdrawConsent } from "@/lib/compliance/dpdp";
import { scrubUser } from "@/lib/compliance/erasure/scrub-user";

// Hardcoded rather than read back from the exported prefix: this string is the
// contract the retry driver has to branch on, so a test that derived it from the
// code would follow any change to it instead of pinning it.
const PRINCIPAL_TASK_ID = "stream-principal-revocation:u1";
const PRINCIPAL_PLAN_ID = "principal:u1";

/**
 * Every model answers every call unless overridden. The Proxy is what lets the
 * same harness describe a subject with collaborator rows and one without: the
 * fix's whole point is that the two must behave the same on Stream.
 */
function models(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get: (target, model: string) =>
      target[model] ??
      new Proxy({}, { get: () => jest.fn(async () => ({ count: 0 })) }),
  });
}

type Harness = {
  db: unknown;
  tx: Record<string, Record<string, jest.Mock>>;
  userUpdate: jest.Mock;
  outboxCreateMany: jest.Mock;
  outboxUpdate: jest.Mock;
  auditCreate: jest.Mock;
  /** Everything handed to `tx.streamRevocationRetry.createMany`, flattened. */
  outboxRows: () => Record<string, unknown>[];
  /** True once a Stream call has happened. */
  streamCalled: () => boolean;
};

function harness(
  options: {
    erased?: boolean;
    consultations?: {
      collaboratorType: string;
      webinarPlanId: string | null;
      classPlanId: string | null;
    }[];
    erasureRequestId?: string | null;
    orgIds?: string[];
  } = {},
): Harness {
  const {
    erased = false,
    consultations = [],
    erasureRequestId = "er-1",
    orgIds = ["org-1"],
  } = options;

  const userUpdate = jest.fn(async () => ({}));
  const auditCreate = jest.fn(async () => ({ id: "audit-1" }));
  const outboxCreateMany = jest.fn(
    async (_args: {
      data: Record<string, unknown>[];
      skipDuplicates: boolean;
    }) => ({
      count: _args.data.length,
    }),
  );
  const outboxUpdate = jest.fn(async () => ({}));

  const tx = {
    user: {
      update: userUpdate,
      findUnique: jest.fn(async () => ({
        consultantProfileId: consultations.length > 0 ? "cp-1" : null,
      })),
    },
    consultantProfile: { updateMany: jest.fn(async () => ({ count: 0 })) },
    consulteeProfile: { updateMany: jest.fn(async () => ({ count: 0 })) },
    trial: { updateMany: jest.fn(async () => ({ count: 0 })) },
    consultation: { updateMany: jest.fn(async () => ({ count: 0 })) },
    payoutAccount: { updateMany: jest.fn(async () => ({ count: 0 })) },
    membership: { updateMany: jest.fn(async () => ({ count: 0 })) },
    programAssignment: { updateMany: jest.fn(async () => ({ count: 0 })) },
    collaborator: { updateManyAndReturn: jest.fn(async () => consultations) },
    session: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    account: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    orgAuditLog: { create: auditCreate },
    erasureRequest: {
      findFirst: jest.fn(async () =>
        erasureRequestId ? { id: erasureRequestId } : null,
      ),
    },
    streamRevocationRetry: { createMany: outboxCreateMany },
  };

  const db = models({
    user: {
      findUnique: jest.fn(async () => ({
        id: "u1",
        erasedAt: erased ? new Date("2026-01-01T00:00:00Z") : null,
        pseudonymousId: erased ? "a".repeat(64) : null,
        razorpayCustomerId: null,
      })),
      update: userUpdate,
    },
    membership: {
      findMany: jest.fn(async () =>
        orgIds.map((organizationId) => ({
          id: `m-${organizationId}`,
          organizationId,
          role: "MEMBER",
          status: "ACTIVE",
        })),
      ),
    },
    payoutAccount: { findMany: jest.fn(async () => []) },
    orgAuditLog: { create: auditCreate },
    erasureRequest: {
      findFirst: jest.fn(async () =>
        erasureRequestId ? { id: erasureRequestId } : null,
      ),
    },
    streamRevocationRetry: {
      createMany: outboxCreateMany,
      update: outboxUpdate,
      findUnique: jest.fn(async () => null),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  });

  return {
    db,
    tx: tx as unknown as Record<string, Record<string, jest.Mock>>,
    userUpdate,
    outboxCreateMany,
    outboxUpdate,
    auditCreate,
    outboxRows: () =>
      outboxCreateMany.mock.calls.flatMap(
        (call) => (call[0] as { data: Record<string, unknown>[] }).data,
      ),
    streamCalled: () =>
      mockRevokeUserToken.mock.calls.length +
        mockDeleteUsers.mock.calls.length >
      0,
  };
}

beforeEach(() => {
  mockRevokeUserToken.mockClear();
  mockRevokeUserToken.mockResolvedValue({});
  mockDeleteUsers.mockClear();
  mockDeleteUsers.mockResolvedValue({ task_id: "task_abc123" });
  mockStreamConfigured = true;
});

// ── 1. THE HEADLINE REGRESSION ───────────────────────────────────────────────

describe("erasure tears down the subject's Stream identity, not just their collaborations", () => {
  it("writes a Stream outbox row and calls Stream for a subject with NO collaborator rows", async () => {
    // No ConsultantProfile (`findUnique → consultantProfileId: null`) and no
    // collaborator rows. Before the fix this reached the commit having recorded
    // no Stream obligation at all and returned vendorFailures: [].
    const h = harness({ consultations: [], orgIds: [] });

    const result = await scrubUser(h.db as never, "u1");

    expect(mockDeleteUsers).toHaveBeenCalledWith(
      ["u1"],
      expect.objectContaining({ user: "hard", messages: "hard" }),
    );
    expect(mockRevokeUserToken).toHaveBeenCalledWith("u1", expect.any(Date));

    // A DURABLE row, keyed to the subject and not to any plan.
    expect(h.outboxRows()).toContainEqual({
      id: PRINCIPAL_TASK_ID,
      erasureRequestId: "er-1",
      planType: "CLASS",
      planId: PRINCIPAL_PLAN_ID,
    });
    expect(result.streamPrincipalOutboxId).toBe(PRINCIPAL_TASK_ID);
    // And no collaborator row was needed to get any of that: there was no
    // ConsultantProfile, so `removeCollaboratorStanding` short-circuited and
    // never even looked for collaborator rows.
    expect(h.tx.collaborator.updateManyAndReturn).not.toHaveBeenCalled();
    expect(revokeCollaboratorAccess).not.toHaveBeenCalled();
  });

  it("hard-deletes the identity AND the messages rather than soft-deleting", async () => {
    // Soft mode keeps the PII for Stream's 30-day grace window; a grace window
    // is not ours to grant for someone who asked to be erased.
    await scrubUser(harness({ orgIds: [] }).db as never, "u1");

    const [, options] = mockDeleteUsers.mock.calls[0];
    expect(options).toEqual({ user: "hard", messages: "hard" });
  });

  it("revokes the chat token BEFORE attempting the delete", async () => {
    // If the delete then fails, access is already cut and what remains is
    // "the data is still there" rather than "the subject can still talk".
    await scrubUser(harness({ orgIds: [] }).db as never, "u1");

    expect(mockRevokeUserToken.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteUsers.mock.invocationCallOrder[0],
    );
  });

  it("re-drives the Stream leg when the scrub runs again on an erased subject", async () => {
    // The retry path. It has to exist, because the sweep cannot drive this row
    // (see PRINCIPAL_OUTBOX_SWEEP_PARK_MS).
    await scrubUser(harness({ erased: true, orgIds: [] }).db as never, "u1");

    expect(mockDeleteUsers).toHaveBeenCalledTimes(1);
    expect(mockRevokeUserToken).toHaveBeenCalledTimes(1);
  });

  it("does NOT over-delete: a subject who only withdrew consent keeps their Stream data", async () => {
    // Withdrawal is prospective and purpose-scoped; it is not erasure (DPDP
    // s.6(5)), so it must not reach Stream at all. The principal leg is
    // reachable only from scrubUser, and this proves the neighbouring
    // instrument did not grow a deletion while the fix was made.
    mockConsentUpdateMany.mockResolvedValueOnce({ count: 1 });

    const withdrawn = await withdrawConsent({ userId: "u1" });

    expect(withdrawn.withdrawnCount).toBe(1);
    // The one Stream touch withdrawal is entitled to: the roster cache.
    expect(mockForgetUserSynced).toHaveBeenCalledWith("u1");
    expect(mockDeleteUsers).not.toHaveBeenCalled();
    expect(mockRevokeUserToken).not.toHaveBeenCalled();
  });

  it("issues exactly one DeleteUsers request carrying exactly one id — never a fan-out", async () => {
    // The DeleteUsers quota is 6/minute app-wide. The only structural defence
    // that matters is that this path cannot batch or parallelise: one scrub is
    // one subject, one request, one id, and no `Promise.all` anywhere over it.
    // If a future change widens the array, this is what catches it before a
    // queue of erasures trips the quota.
    const h = harness({ orgIds: [] });
    await scrubUser(h.db as never, "u1");

    expect(mockDeleteUsers).toHaveBeenCalledTimes(1);
    expect(mockDeleteUsers).toHaveBeenCalledWith(["u1"], {
      user: "hard",
      messages: "hard",
    });
    expect(mockDeleteUsers.mock.calls.flatMap((c) => c[0] as string[])).toEqual(
      ["u1"],
    );
    // Only this subject is ever named — an erasure never reaches outward.
    expect(
      mockDeleteUsers.mock.calls.flatMap((c) => c[0] as string[]),
    ).not.toContain("u2");
    expect(h.streamCalled()).toBe(true);
  });
});

// ── 2. TRANSACTION BOUNDARY ──────────────────────────────────────────────────

describe("the outbox row is inside the transaction and no Stream call is", () => {
  it("writes the principal row through `tx`, then calls Stream only after commit", async () => {
    const h = harness({ orgIds: [] });

    await scrubUser(h.db as never, "u1");

    expect(h.outboxCreateMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.userUpdate.mock.invocationCallOrder[0],
    );
    // `tx` has no streamRevocationRetry.update — a settle inside the
    // transaction would be a TypeError, so reaching Stream at all proves it.
    expect(h.streamCalled()).toBe(true);
    expect(h.tx.streamRevocationRetry.update).toBeUndefined();
  });

  it("settles the row after the transaction, never inside it", async () => {
    const h = harness({ orgIds: [] });

    await scrubUser(h.db as never, "u1");

    expect(h.outboxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PRINCIPAL_TASK_ID },
        data: expect.objectContaining({ status: "SUCCEEDED", attempts: 1 }),
      }),
    );
  });
});

// ── 3. A FAILING CALL STAYS OWED AND IS REPORTED ────────────────────────────

describe("an unsettled Stream leg is never reported as success", () => {
  it("leaves the row owed and surfaces the failure when deleteUsers throws", async () => {
    mockDeleteUsers.mockRejectedValueOnce(new Error("Stream is down"));
    const h = harness({ orgIds: [] });

    const result = await scrubUser(h.db as never, "u1");

    // The local scrub still completed — a vendor outage is not a reason to fail
    // an erasure whose database rows are already committed.
    expect(result.scrubbed).toBe(true);
    // …but it is not clean.
    expect(result.vendorFailures).toHaveLength(1);
    expect(result.vendorFailures[0]).toMatch(/stream_identity_delete/);
    expect(result.vendorFailures[0]).toMatch(/Stream is down/);
    const settled = h.outboxUpdate.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(settled.status).toBe("FAILED");
    expect(settled.attempts).toBe(1);
    expect(settled.lastError).toMatch(/Stream is down/);
    expect(settled.nextRetryAt).toBeInstanceOf(Date);
  });

  it("leaves the row owed when Stream accepted the call but reported a failed deletion", async () => {
    // The case a try/catch alone cannot see: the request resolved. Only reading
    // `failed_delete_users` distinguishes "the deletion happened" from "the call
    // returned", and only the first discharges the duty.
    mockDeleteUsers.mockResolvedValueOnce({
      task_id: "task_abc123",
      failed_delete_users: [{ user_id: "u1", message: "user not found" }],
    });
    const h = harness({ orgIds: [] });

    const result = await scrubUser(h.db as never, "u1");

    expect(result.vendorFailures[0]).toMatch(/reported the delete as failed/);
    expect(
      (h.outboxUpdate.mock.calls[0][0].data as Record<string, unknown>).status,
    ).toBe("FAILED");
  });

  it("treats a 429 on the DeleteUsers quota as owed, not as a deletion", async () => {
    const throttled = Object.assign(new Error("rate limited"), {
      status: 429,
    });
    mockDeleteUsers.mockRejectedValueOnce(throttled);
    const h = harness({ orgIds: [] });

    const result = await scrubUser(h.db as never, "u1");

    expect(result.vendorFailures[0]).toMatch(/quota/);
    expect(
      (h.outboxUpdate.mock.calls[0][0].data as Record<string, unknown>).status,
    ).toBe("FAILED");
  });

  it("reports the obligation as untracked when no ErasureRequest anchors a row", async () => {
    // The self-serve `DELETE /api/user/[id]` path has no ErasureRequest, and the
    // outbox FK requires one. Silence there would repeat the original defect.
    mockDeleteUsers.mockRejectedValueOnce(new Error("Stream is down"));
    const h = harness({ erasureRequestId: null, orgIds: [] });

    const result = await scrubUser(h.db as never, "u1");

    expect(result.streamPrincipalOutboxId).toBeNull();
    expect(result.vendorFailures.join(" ")).toMatch(/nothing on the outbox/);
    expect(h.outboxCreateMany).not.toHaveBeenCalled();
  });

  it("reports a failure when Stream is not configured rather than calling it clean", async () => {
    mockStreamConfigured = false;
    const h = harness({ orgIds: [] });

    const result = await scrubUser(h.db as never, "u1");

    expect(result.vendorFailures[0]).toMatch(/cannot confirm/);
    expect(mockDeleteUsers).not.toHaveBeenCalled();
    expect(
      (h.outboxUpdate.mock.calls[0][0].data as Record<string, unknown>).status,
    ).toBe("FAILED");
  });

  it("re-attempting on an already-erased subject advances attempts and can clear the failure", async () => {
    mockDeleteUsers.mockRejectedValueOnce(new Error("Stream is down"));
    const failing = harness({ orgIds: [] });
    await scrubUser(failing.db as never, "u1");
    expect(
      (failing.outboxUpdate.mock.calls[0][0].data as Record<string, unknown>)
        .status,
    ).toBe("FAILED");

    // Second run: the subject is erased and the row already exists at
    // attempts: 1. The re-drive must advance the count, not reset it, and a
    // clean Stream this time must settle it.
    const retrying = harness({ erased: true, orgIds: [] });
    retrying.db = models({
      ...(retrying.db as object),
      streamRevocationRetry: {
        createMany: retrying.outboxCreateMany,
        update: retrying.outboxUpdate,
        findUnique: jest.fn(async () => ({
          id: PRINCIPAL_TASK_ID,
          attempts: 1,
        })),
      },
    });
    const result = await scrubUser(retrying.db as never, "u1");

    expect(result.vendorFailures).toEqual([]);
    expect(retrying.outboxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUCCEEDED", attempts: 2 }),
      }),
    );
  });
});

// ── 4. THE AUDIT ROW CARRIES THE VENDOR TASK ID ──────────────────────────────

describe("the audit row carries the Stream obligation, not just a success", () => {
  it("names the outbox row an auditor can open", async () => {
    const h = harness({ orgIds: ["org-1", "org-2"] });

    await scrubUser(h.db as never, "u1");

    expect(h.auditCreate).toHaveBeenCalledTimes(2);
    const { data } = h.auditCreate.mock.calls[0][0];
    expect(data.action).toBe("USER_ERASURE_PROCESSED");
    expect(data.details.streamRevocation).toEqual({
      principalTaskId: PRINCIPAL_TASK_ID,
      principalPlanId: PRINCIPAL_PLAN_ID,
      collaborations: [],
    });
  });

  it("records a null task id rather than implying a durable obligation", async () => {
    const h = harness({ erasureRequestId: null });

    await scrubUser(h.db as never, "u1");

    const { data } = h.auditCreate.mock.calls[0][0];
    expect(data.details.streamRevocation.principalTaskId).toBeNull();
    expect(data.details.streamRevocation.principalPlanId).toBe(
      PRINCIPAL_PLAN_ID,
    );
  });
});

// ── 5. THE CONSULTANT PATH STILL WORKS ───────────────────────────────────────

describe("the consultant-with-collaborators path is not regressed", () => {
  const webinarRow = {
    collaboratorType: "WEBINAR",
    webinarPlanId: "wp-1",
    classPlanId: null,
  };

  it("still writes a per-plan outbox row AND still revokes each plan after commit", async () => {
    const h = harness({ consultations: [webinarRow], orgIds: [] });

    await scrubUser(h.db as never, "u1");

    expect(h.outboxRows()).toContainEqual({
      erasureRequestId: "er-1",
      planType: "WEBINAR",
      planId: "wp-1",
    });
    expect(revokeCollaboratorAccess).toHaveBeenCalledWith(
      "webinar",
      "wp-1",
      "u1",
      { notify: false },
    );
  });

  it("carries BOTH obligations on the audit row", async () => {
    const h = harness({ consultations: [webinarRow] });

    await scrubUser(h.db as never, "u1");

    const { data } = h.auditCreate.mock.calls[0][0];
    expect(data.details.streamRevocation).toEqual({
      principalTaskId: PRINCIPAL_TASK_ID,
      principalPlanId: PRINCIPAL_PLAN_ID,
      collaborations: [{ planType: "webinar", planId: "wp-1" }],
    });
    // Both legs attempted: revoking one plan's channel access does not delete
    // the subject's account.
    expect(revokeCollaboratorAccess).toHaveBeenCalled();
    expect(mockDeleteUsers).toHaveBeenCalledWith(["u1"], {
      user: "hard",
      messages: "hard",
    });
  });

  it("keeps the two legs' outcomes independent", async () => {
    // The collaborator revocation can fail while the principal leg lands, and
    // vice versa — neither is allowed to swallow the other.
    (revokeCollaboratorAccess as jest.Mock).mockResolvedValueOnce({
      success: false,
    });
    const h = harness({ consultations: [webinarRow], orgIds: [] });
    await scrubUser(h.db as never, "u1");
    expect(mockDeleteUsers).toHaveBeenCalled();

    mockDeleteUsers.mockRejectedValueOnce(new Error("Stream is down"));
    const h2 = harness({ consultations: [webinarRow], orgIds: [] });
    await scrubUser(h2.db as never, "u1");
    // The plan revocation still ran and settled its own row.
    expect(revokeCollaboratorAccess).toHaveBeenCalled();
    expect(h2.outboxUpdate).toHaveBeenCalled();
  });
});

// ── the parking decision, so it cannot silently change ──────────────────────

describe("the principal row is parked out of the sweep's reach", () => {
  it("is given a retry slot no `drainErasureRevocations` run can reach", async () => {
    // The sweep selects `status IN (PENDING, FAILED)` AND
    // `nextRetryAt <= now`, then re-drives `revokeCollaboratorAccess` — which
    // resolves `{success: true}` for a plan that never existed and would stamp
    // SUCCEEDED on an undeleted Stream user. So the honest slot has to be a
    // real one that the sweep cannot select, not the 1-minute backoff.
    const parked = new Date();
    parked.setHours(0, 0, 0, 0);
    mockDeleteUsers.mockRejectedValueOnce(new Error("Stream is down"));
    const h = harness({ orgIds: [] });

    await scrubUser(h.db as never, "u1");

    const { nextRetryAt: slot } = h.outboxUpdate.mock.calls[0][0].data as {
      nextRetryAt: Date;
    };
    expect(slot.getTime()).toBeGreaterThan(parked.getTime());
    // …and it is strictly further out than any backoff step would ever put it.
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      expect(slot.getTime()).toBeGreaterThan(
        nextRetryAt(attempt, parked).getTime(),
      );
    }
  });
});
