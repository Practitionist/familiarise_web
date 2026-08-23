/**
 * @jest-environment node
 */

/**
 * Resumable-onboarding drafts (#onboarding-ux).
 *
 * Covers the session-scoping of the draft server actions, the JSON
 * sanitizer/reviver round-trip that makes wizard state safe for a Prisma Json
 * column, and the size gate.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    onboardingDraft: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(),
}));

import {
  clearOnboardingDraftAction,
  loadOnboardingDraftAction,
  saveOnboardingDraftAction,
} from "../../actions/onboarding-draft.action";
import { getSession } from "../../lib/auth-server";
import prisma from "../../lib/prisma";
import {
  ONBOARDING_DRAFT_MAX_BYTES,
  createDraftSaveQueue,
  encodeDraftForSave,
  reviveDraftPayload,
  sanitizeDraftValue,
} from "../../utils/onboarding-draft";

const mockGetSession = getSession as unknown as jest.Mock;
const mockUpsert = prisma.onboardingDraft.upsert as unknown as jest.Mock;
const mockFindUnique = prisma.onboardingDraft.findUnique as unknown as jest.Mock;
const mockDeleteMany = prisma.onboardingDraft.deleteMany as unknown as jest.Mock;

// A class NAMED File exercises the structural recognizer without needing the
// DOM File global in the node environment.
class File {}

const USER_ID = "user-1";

describe("sanitizeDraftValue", () => {
  it("drops functions, undefined, and File-like objects but keeps falsy primitives", () => {
    const input = {
      name: "",
      onlineStatus: false,
      attempts: 0,
      notes: null,
      callback: () => "nope",
      missing: undefined,
      attachment: new File(),
      nested: { deep: { deeper: [1, "two", true] } },
    };

    const out = sanitizeDraftValue(input) as Record<string, unknown>;

    expect(out).toEqual({
      name: "",
      onlineStatus: false,
      attempts: 0,
      notes: null,
      nested: { deep: { deeper: [1, "two", true] } },
    });
    expect(out).not.toHaveProperty("callback");
    expect(out).not.toHaveProperty("missing");
    expect(out).not.toHaveProperty("attachment");
  });

  it("converts Dates to ISO strings and drops invalid dates", () => {
    const dob = new Date("1990-06-15T00:00:00.000Z");
    const out = sanitizeDraftValue({ dateOfBirth: dob, bad: new Date(NaN) });
    expect(out).toEqual({ dateOfBirth: "1990-06-15T00:00:00.000Z" });
  });

  it("bounds runaway structures instead of recursing forever", () => {
    const deep = { v: 1 } as Record<string, unknown>;
    let cursor = deep;
    for (let i = 0; i < 50; i++) {
      cursor.next = { v: i };
      cursor = cursor.next as Record<string, unknown>;
    }
    // Must terminate and produce bounded output rather than throw/hang.
    expect(sanitizeDraftValue(deep)).toBeDefined();
  });
});

describe("reviveDraftPayload", () => {
  it("restores date-typed fields from ISO strings produced by the write path", () => {
    const revived = reviveDraftPayload({
      name: "Ada",
      dateOfBirth: "1990-06-15T00:00:00.000Z",
      emailVerified: "2026-08-01T10:00:00.000Z",
      termsAccepted: true,
    });

    expect(revived.dateOfBirth).toBeInstanceOf(Date);
    expect(revived.emailVerified).toBeInstanceOf(Date);
    expect((revived.dateOfBirth as Date).toISOString()).toBe(
      "1990-06-15T00:00:00.000Z",
    );
    expect(revived.name).toBe("Ada");
  });

  it("leaves non-date fields untouched and never throws on garbage", () => {
    expect(reviveDraftPayload(null)).toEqual({});
    expect(reviveDraftPayload("junk")).toEqual({});
    expect(reviveDraftPayload({ dateOfBirth: "not-a-date" })).toHaveProperty(
      "dateOfBirth",
      "not-a-date",
    );
  });
});

describe("encodeDraftForSave", () => {
  it("rejects payloads over the serialized size budget", () => {
    const bloated = { bio: "x".repeat(ONBOARDING_DRAFT_MAX_BYTES + 10) };
    expect(encodeDraftForSave({ role: null, currentStep: 0, payload: bloated })).toBeNull();
  });

  it("accepts a realistic filled consultant form", () => {
    const payload = {
      role: "CONSULTANT",
      name: "Ada",
      weeklySlots: Array.from({ length: 14 }, (_, i) => ({
        startDay: "MONDAY",
        startTimeUtc: i * 30,
        endDay: "MONDAY",
        endTimeUtc: i * 30 + 30,
      })),
    };
    expect(
      encodeDraftForSave({
        role: "CONSULTANT" as never,
        currentStep: 3,
        payload,
      }),
    ).not.toBeNull();
  });
});

describe("saveOnboardingDraftAction", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockUpsert.mockResolvedValue({});
  });

  it("rejects an unauthenticated caller without touching the database", async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(saveOnboardingDraftAction(validInput())).resolves.toEqual({
      success: false,
      error: "Unauthorized",
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects malformed input at the boundary (strict schema)", async () => {
    const result = await saveOnboardingDraftAction({
      ...validInput(),
      currentStep: 999,
    });
    expect(result.success).toBe(false);

    const extraKey = { ...validInput(), smuggled: true };
    await expect(saveOnboardingDraftAction(extraKey)).resolves.toMatchObject({
      success: false,
    });

    const badRole = { ...validInput(), role: "ADMIN" };
    await expect(saveOnboardingDraftAction(badRole)).resolves.toMatchObject({
      success: false,
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("scopes the upsert to the session user and sanitizes before persisting", async () => {
    const input = validInput({
      payload: {
        name: "Ada",
        dateOfBirth: new Date("1990-06-15T00:00:00.000Z"),
        sneaky: new File(),
      },
    });

    await expect(saveOnboardingDraftAction(input)).resolves.toEqual({
      success: true,
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const args = mockUpsert.mock.calls[0][0];
    expect(args.where).toEqual({ userId: USER_ID });
    expect(args.create.userId).toBe(USER_ID); // session id, never caller-supplied
    expect(args.create.payload).toEqual({
      name: "Ada",
      dateOfBirth: "1990-06-15T00:00:00.000Z",
    }); // Date stringified, File dropped
  });

  it("refuses payloads exceeding the size budget", async () => {
    const result = await saveOnboardingDraftAction(
      validInput({ payload: { blob: "x".repeat(ONBOARDING_DRAFT_MAX_BYTES) } }),
    );
    expect(result).toEqual({
      success: false,
      error: "Invalid or oversized draft payload",
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("loadOnboardingDraftAction", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
  });

  it("rejects an unauthenticated caller", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(loadOnboardingDraftAction()).resolves.toEqual({
      success: false,
      error: "Unauthorized",
    });
  });

  it("returns null when no draft row exists", async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(loadOnboardingDraftAction()).resolves.toEqual({
      success: true,
      draft: null,
    });
  });

  it("revives dates when returning a stored snapshot", async () => {
    mockFindUnique.mockResolvedValue({
      role: "CONSULTANT",
      currentStep: 2,
      payload: {
        name: "Ada",
        dateOfBirth: "1990-06-15T00:00:00.000Z",
      },
    });

    const result = await loadOnboardingDraftAction();
    expect(result.success).toBe(true);
    if (!result.success || !result.draft) throw new Error("unreachable");
    expect(result.draft.currentStep).toBe(2);
    expect(result.draft.payload.dateOfBirth).toBeInstanceOf(Date);
  });
});

describe("clearOnboardingDraftAction", () => {
  it("deletes only the session user's row and is idempotent", async () => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockDeleteMany.mockResolvedValue({ count: 1 });

    await expect(clearOnboardingDraftAction()).resolves.toEqual({
      success: true,
    });
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    });

    mockGetSession.mockResolvedValue(null);
    await expect(clearOnboardingDraftAction()).resolves.toMatchObject({
      success: false,
    });
  });
});

describe("createDraftSaveQueue", () => {
  it("serializes tasks in enqueue order even when they would resolve out of order", async () => {
    const queue = createDraftSaveQueue();
    const order: string[] = [];

    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = queue.enqueue(async () => {
      await gate; // slow save dispatched EARLY
      order.push("first");
    });
    const second = queue.enqueue(async () => {
      order.push("second"); // fast save dispatched LATE
    });

    expect(order).toEqual([]); // second must wait for the first to settle
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("runs later tasks even when an earlier task rejected", async () => {
    const queue = createDraftSaveQueue();

    const failing = queue.enqueue(async () => {
      throw new Error("network down");
    });
    await expect(failing).rejects.toThrow("network down");

    await expect(queue.enqueue(async () => "ok")).resolves.toBe("ok");
  });

  it("drain resolves only after every in-flight task has settled", async () => {
    const queue = createDraftSaveQueue();
    let settled = false;
    void queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      settled = true;
    });

    await queue.drain();
    expect(settled).toBe(true);
  });

  it("drain never rejects, even when a drained task failed", async () => {
    const queue = createDraftSaveQueue();
    void queue
      .enqueue(async () => {
        throw new Error("boom");
      })
      .catch(() => {});

    await expect(queue.drain()).resolves.toBeUndefined();
    // Queue stays usable after a failure.
    await expect(queue.enqueue(async () => "next")).resolves.toBe("next");
  });
});

function validInput(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    role: "CONSULTEE",
    currentStep: 1,
    payload: { name: "Ada", termsAccepted: false },
    ...overrides,
  };
}
