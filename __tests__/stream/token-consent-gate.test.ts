/**
 * @jest-environment node
 */

/**
 * DPDP Gap #3 — a withdrawn `STREAM_DATA_PROCESSING` consent did not stop chat
 * or video, and nothing on the platform said so.
 *
 * The consent predicate was real and fail-closed, but it was consulted in
 * exactly TWO places, both inside `actions/stream/chat/user.action.ts` — i.e.
 * only on the Stream user upsert. Not in `chatTokenProvider`, not in
 * `tokenProvider`, and not in `resolveMeetingAccess`. So:
 *
 *   - a user who withdrew kept an open socket, because withdrawal never touched
 *     the connection it was already holding;
 *   - and they could re-mint a FRESH one-hour token
 *     (`STREAM_TOKEN_TTL_SECONDS = 3600`) any time the client cache expired,
 *     indefinitely, because the upsert gate is skipped entirely once
 *     `isUserSynced` says the user is already in Stream — which is exactly the
 *     state a long-lived session is in.
 *
 * `DELETE /api/organizations/[orgId]/consent` flipped `withdrawnAt` and wrote an
 * audit row. Nothing else happened anywhere on the platform.
 *
 * These tests pin the two surfaces that close it — the mint and the join — plus
 * the teardown that stops the socket which predates both. They also pin the
 * orderings, because both are security properties rather than style: consent is
 * checked LAST so the action cannot be turned into a consent oracle, and it is
 * checked for the SUBJECT so a privileged caller cannot launder consent.
 */

const mockGetSession = jest.fn();
const mockCheckConsent = jest.fn();
const mockGenerateVideoToken = jest.fn();
const mockGenerateChatToken = jest.fn();
const mockRevokeUserToken = jest.fn();
const mockDeactivateUser = jest.fn();
const mockCaptureException = jest.fn();

const warn = jest.fn();
const error = jest.fn();

jest.mock("../../lib/auth-server", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

jest.mock("../../lib/auth-helpers", () => ({
  isPrivileged: (role: string) => role === "admin" || role === "super_admin",
}));

jest.mock("../../lib/compliance/dpdp", () => ({
  checkConsent: (...a: unknown[]) => mockCheckConsent(...a),
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  generateVideoToken: (...a: unknown[]) => mockGenerateVideoToken(...a),
  generateChatToken: (...a: unknown[]) => mockGenerateChatToken(...a),
  getStreamChatClient: () => ({
    revokeUserToken: (...a: unknown[]) => mockRevokeUserToken(...a),
    deactivateUser: (...a: unknown[]) => mockDeactivateUser(...a),
  }),
  // Real pass-through, not a swallow: `withCircuitBreaker(op, fallback)` returns
  // the fallback INSTEAD of throwing, which would hide every Stream failure
  // behind a fake success.
  withStreamCircuitBreaker: async (op: () => Promise<unknown>) => op(),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: (...a: unknown[]) => warn(...a),
    error: (...a: unknown[]) => error(...a),
    debug: jest.fn(),
  },
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
}));

import {
  chatTokenProvider,
  tokenProvider,
} from "../../actions/stream/chat/stream.action";
import { PURPOSE_CODES } from "../../lib/compliance/purpose-codes";

const USER = "user_1";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: USER, banned: false } });
  mockCheckConsent.mockResolvedValue(true);
  mockGenerateVideoToken.mockReturnValue("video-token");
  mockGenerateChatToken.mockReturnValue("chat-token");
  mockRevokeUserToken.mockResolvedValue(undefined);
  mockCaptureException.mockReturnValue("evt");
  // Default: consent present.
});

describe("a subject with STREAM_DATA_PROCESSING consent is unaffected", () => {
  it("mints a chat token exactly as before", async () => {
    const result = await chatTokenProvider(USER);

    expect(result).toEqual({ ok: true, data: "chat-token" });
    expect(mockRevokeUserToken).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("mints a video token exactly as before", async () => {
    const result = await tokenProvider(USER);

    expect(result).toEqual({ ok: true, data: "video-token" });
    expect(mockRevokeUserToken).not.toHaveBeenCalled();
  });

  it("reads consent for the STREAM purpose, not some other one", async () => {
    await chatTokenProvider(USER);

    // Purpose-scoped is the whole taxonomy (Subject ⇄ Processing separation);
    // a user-level boolean is the named anti-pattern.
    expect(mockCheckConsent).toHaveBeenCalledWith({
      userId: USER,
      purposeCode: PURPOSE_CODES.STREAM_DATA_PROCESSING,
    });
  });
});

describe("a subject whose consent is withdrawn cannot mint a token", () => {
  beforeEach(() => {
    // What checkConsent answers for a missing artifact, a withdrawn one, and
    // one past its retention window — all three, identically: false.
    mockCheckConsent.mockResolvedValue(false);
  });

  it.each([
    ["chat", chatTokenProvider],
    ["video", tokenProvider],
  ] as const)("refuses the %s token", async (_label, provider) => {
    const result = await provider(USER);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "CONSENT_REQUIRED",
        message: expect.stringContaining("data-processing consent"),
      },
    });
    // The credential itself was never generated.
    expect(mockGenerateChatToken).not.toHaveBeenCalled();
    expect(mockGenerateVideoToken).not.toHaveBeenCalled();
  });

  it("answers with a refusal, not an exception — the client renders it", async () => {
    // The provider already handles a Refusal from this action
    // (`refusedConnectFailure` in StreamProviderImpl) without retrying or
    // reporting. Throwing would send it to Sentry and the backoff loop.
    const result = await chatTokenProvider(USER);

    expect(result.ok).toBe(false);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("is a deliberate refusal, so it never reaches the error log", async () => {
    // Matches `upsertUserToStream`, which rethrows ConsentRequiredError
    // "without an error-level log so it doesn't pollute error-monitoring
    // dashboards with false positives".
    await tokenProvider(USER);

    expect(warn).toHaveBeenCalledWith(
      "Refusing Stream token mint — STREAM_DATA_PROCESSING consent absent",
      expect.objectContaining({ userId: USER, requestedBy: USER }),
    );
    expect(error).not.toHaveBeenCalled();
  });
});

describe("withdrawal also kills the socket that predates it", () => {
  beforeEach(() => {
    mockCheckConsent.mockResolvedValue(false);
  });

  it("revokes the subject's already-issued tokens", async () => {
    await chatTokenProvider(USER);
    // The revocation is deliberately not awaited into the verdict, so let the
    // microtask queue drain before asserting on it.
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockRevokeUserToken).toHaveBeenCalledTimes(1);
    // `revokeUserToken(id, now)` sets `revoke_tokens_issued_before = now`,
    // which invalidates every token issued before that instant — including the
    // one the open socket is holding. That is the live-socket teardown.
    const [id, cutoff] = mockRevokeUserToken.mock.calls[0] as [string, Date];
    expect(id).toBe(USER);
    expect(cutoff).toBeInstanceOf(Date);
  });

  it("does NOT deactivate the account", async () => {
    await chatTokenProvider(USER);
    await new Promise((resolve) => setImmediate(resolve));

    // Consent withdrawal is REVERSIBLE — an org admin re-grants through the
    // consent route — and `deactivateUser` is permanent, with no automated undo.
    // Using it here would trade a legal defect for a support one.
    expect(mockDeactivateUser).not.toHaveBeenCalled();
  });

  it("refuses even when Stream is down — the verdict does not depend on it", async () => {
    mockRevokeUserToken.mockRejectedValue(new Error("stream outage"));

    const result = await chatTokenProvider(USER);
    await new Promise((resolve) => setImmediate(resolve));

    // Fail-CLOSED: the gate refuses because consent is absent, not because
    // Stream answered. An outage must not become a 500, and must not become the
    // reason a token was issued.
    expect(result.ok).toBe(false);
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not revoke Stream tokens"),
      expect.objectContaining({ userId: USER }),
    );
  });
});

describe("the identity checks still run first", () => {
  it("answers UNAUTHENTICATED without reading any consent row", async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await chatTokenProvider(USER);

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "UNAUTHENTICATED" },
    });
    expect(mockCheckConsent).not.toHaveBeenCalled();
  });

  it("refuses a suspended account without reading any consent row", async () => {
    mockGetSession.mockResolvedValue({ user: { id: USER, banned: true } });

    await expect(chatTokenProvider(USER)).rejects.toThrow(
      "Forbidden: account suspended",
    );
    expect(mockCheckConsent).not.toHaveBeenCalled();
  });

  it("is not a consent oracle for another user's id", async () => {
    // The ordering is the security property. `checkConsent` is a database read
    // keyed by a caller-supplied id, so checking it before the cross-user check
    // would let any signed-in user ask "does <arbitrary-id> consent to
    // stream?" by looking at whether the answer is a token or a refusal.
    mockGetSession.mockResolvedValue({
      user: { id: "attacker", banned: false },
    });

    await expect(chatTokenProvider("victim")).rejects.toThrow(
      "Forbidden: cannot mint a token for another user",
    );
    expect(mockCheckConsent).not.toHaveBeenCalled();
  });

  it("gates the SUBJECT, so a privileged caller cannot launder consent", async () => {
    // Consent is per (subject × purpose). An operator holding `admin` has no
    // consent on someone else's behalf, so the gate reads the SUBJECT's row.
    mockGetSession.mockResolvedValue({
      user: { id: "operator_1", banned: false, role: "admin" },
    });
    mockCheckConsent.mockResolvedValue(false);

    const result = await chatTokenProvider("victim");

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "CONSENT_REQUIRED" },
    });
    expect(mockCheckConsent).toHaveBeenCalledWith({
      userId: "victim",
      purposeCode: PURPOSE_CODES.STREAM_DATA_PROCESSING,
    });
  });

  it("still lets a privileged caller mint for a consenting subject", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "operator_1", banned: false, role: "admin" },
    });

    const result = await chatTokenProvider("victim");

    expect(result).toEqual({ ok: true, data: "chat-token" });
  });
});

/**
 * The SECOND surface. Refusing only the mint would leave this resolver saying
 * "granted", the Join affordance drawn, and the join route writing Stream call
 * membership for a user who has withdrawn — the exact "gate and affordance
 * disagree" failure this module's header says it exists to prevent.
 *
 * The real resolver is required directly; the mocks above only cover the token
 * action. `jest.mock` is hoisted above every `const` in this file, so the fake
 * client is built INSIDE the factory and read back off the mocked module below.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    appointmentParticipant: { findFirst: jest.fn() },
    collaborator: { findFirst: jest.fn() },
    appointmentOccurrence: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}));

const db = jest.requireMock("../../lib/prisma").default as {
  meeting: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
  appointmentParticipant: { findFirst: jest.Mock };
  collaborator: { findFirst: jest.Mock };
  appointmentOccurrence: { findMany: jest.Mock; findFirst: jest.Mock };
};

const { resolveMeetingAccess, STREAM_CONSENT_REFUSAL } = jest.requireActual<
  typeof import("../../lib/meetings/access")
>("../../lib/meetings/access");

const MINUTE = 60 * 1000;

/** A paid consultation that is under way right now — only consent can refuse it. */
function seedLiveConsultation(opts: { hostJoins?: boolean } = {}) {
  db.meeting.findUnique.mockResolvedValue({
    id: "ms-1",
    streamCallId: "slot-abc",
    endedAt: null,
    endedReason: null,
    occurrence: {
      id: "slot-1",
      startsAt: new Date(Date.now() - 5 * MINUTE),
      endsAt: new Date(Date.now() + 25 * MINUTE),
      isTentative: false,
      completionStatus: "SCHEDULED",
      deletedAt: null,
      appointmentId: "appt-1",
      appointment: {
        id: "appt-1",
        deletedAt: null,
        consultation: {
          status: "APPROVED",
          consultationPlan: {
            consultantProfileId: "cp-1",
            recordingEnabled: false,
          },
        },
        subscription: null,
        webinar: null,
        class: null,
        trial: null,
      },
    },
  });
  db.appointmentParticipant.findFirst.mockResolvedValue(
    opts.hostJoins ? null : { id: "seat-1" },
  );
  db.appointmentOccurrence.findMany.mockResolvedValue([]);
  db.appointmentOccurrence.findFirst.mockResolvedValue(null);
  db.collaborator.findFirst.mockResolvedValue(null);
  db.user.findUnique.mockResolvedValue({
    consultantProfileId: opts.hostJoins ? "cp-1" : null,
  });
}

describe("resolveMeetingAccess refuses a meeting join without consent", () => {
  beforeEach(() => {
    mockCheckConsent.mockResolvedValue(false);
  });

  it("refuses an attendee who withdrew", async () => {
    seedLiveConsultation();

    const access = await resolveMeetingAccess("slot-abc", USER);

    expect(access.hasAccess).toBe(false);
    expect(access.role).toBeNull();
    expect(access.message).toBe(STREAM_CONSENT_REFUSAL);
    // `unauthorized` — which is what the join route turns into 403, and what
    // validate-access returns as "no".
    expect(access.reason).toBe("unauthorized");
  });

  it("refuses the HOST too — a consultant who withdrew is just as subject to it", async () => {
    seedLiveConsultation({ hostJoins: true });

    const access = await resolveMeetingAccess("slot-abc", USER);

    expect(access.hasAccess).toBe(false);
    expect(access.message).toBe(STREAM_CONSENT_REFUSAL);
  });

  it("answers with the CONSENT reason, not a statement about the booking", async () => {
    // Placement matters. After the status checks, a withdrawn user would be told
    // "This session has ended" or "This booking is no longer active" — true of
    // the booking, wrong as the reason, and the sentence a support agent would
    // then relay.
    seedLiveConsultation();

    const { message } = await resolveMeetingAccess("slot-abc", USER);

    expect(message).not.toMatch(/ended|not confirmed|no longer active/i);
    expect(message).toMatch(/consent/i);
  });

  it("still 404s a meeting that does not exist, and reads no consent", async () => {
    db.meeting.findUnique.mockResolvedValue(null);

    const access = await resolveMeetingAccess("nope", USER);

    expect(access.reason).toBe("not_found");
    expect(mockCheckConsent).not.toHaveBeenCalled();
  });

  it("refuses a non-attendee who withdrew the same way — never a grant either", async () => {
    // The gate sits on the single path to a grant, so the fallthrough
    // ("not authorized") and the consent refusal are independent refusals. Here
    // the caller is the host, which is the only arm that reaches `grant`.
    seedLiveConsultation({ hostJoins: true });
    mockCheckConsent.mockResolvedValue(true);
    db.user.findUnique.mockResolvedValue({
      consultantProfileId: "someone-else",
    });

    const access = await resolveMeetingAccess("slot-abc", USER);

    expect(access.hasAccess).toBe(false);
    expect(access.reason).toBe("unauthorized");
  });

  it("fails CLOSED when the consent read itself fails", async () => {
    // A throw must not be swallowed into a grant. The correct outcome for a DB
    // blip here is no grant and an error the caller surfaces — never a token
    // issued because the gate could not be evaluated.
    seedLiveConsultation();
    mockCheckConsent.mockRejectedValue(new Error("db down"));

    await expect(resolveMeetingAccess("slot-abc", USER)).rejects.toThrow(
      "db down",
    );
  });
});

describe("resolveMeetingAccess is unchanged when consent is present", () => {
  beforeEach(() => {
    mockCheckConsent.mockResolvedValue(true);
  });

  it("still admits an attendee on a paid consultation under way", async () => {
    seedLiveConsultation();

    const access = await resolveMeetingAccess("slot-abc", USER);

    expect(access.hasAccess).toBe(true);
    expect(access.role).toBe("participant");
    expect(access.reason).toBe("granted");
  });

  it("still admits the host", async () => {
    seedLiveConsultation({ hostJoins: true });

    const access = await resolveMeetingAccess("slot-abc", USER);

    expect(access.hasAccess).toBe(true);
    expect(access.role).toBe("host");
  });

  it("reads consent once per resolution, not once per grant arm", async () => {
    seedLiveConsultation();

    await resolveMeetingAccess("slot-abc", USER);

    expect(mockCheckConsent).toHaveBeenCalledTimes(1);
  });
});
