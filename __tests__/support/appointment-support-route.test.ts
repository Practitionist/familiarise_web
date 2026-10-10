/**
 * @jest-environment node
 */

/**
 * #support-hub — per-appointment support thread ROUTE wiring.
 *
 * The regression that started this: seeded demo databases mint readable slug
 * ids (`demo0813-appt-ba`), and the old `z.string().uuid()` param gate 400'd
 * them with "Invalid appointment id" before the DB lookup could speak — the
 * toast every consultant on the preview deploy saw. These pin the opaque-id
 * contract and the coded envelope at the route boundary.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// The REAL appointmentAuthzError must run (its mapping is what the route
// ships), so appointment-access is only half-mocked below — which means its
// own imports need mocks too, or requireActual drags in better-auth's ESM.
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  isPrivileged: jest.fn(),
}));
jest.mock("../../lib/auth/org-permissions", () => ({
  __esModule: true,
  hasOrgPermission: jest.fn(),
}));
jest.mock("../../lib/data/appointment-detail", () => ({
  __esModule: true,
  readAppointmentDetail: jest.fn(),
  canAccessAppointment: jest.fn(),
}));

jest.mock("../../lib/api/appointment-access", () => ({
  __esModule: true,
  ...jest.requireActual("../../lib/api/appointment-access"),
  authorizeAppointment: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentSupportThread: { findUnique: jest.fn() },
  },
}));

jest.mock("../../lib/support/service", () => ({
  __esModule: true,
  runSupportTurn: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  spamLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));

jest.mock("../../lib/support/context", () => ({
  __esModule: true,
  buildSupportContext: jest.fn(),
}));

import { NextRequest } from "next/server";
import { authorizeAppointment } from "../../lib/api/appointment-access";
import { applyRateLimit } from "../../lib/rate-limit";
import prisma from "../../lib/prisma";
import { buildSupportContext } from "../../lib/support/context";
import { runSupportTurn } from "../../lib/support/service";
import {
  GET,
  POST,
} from "../../app/api/appointments/[appointmentId]/support/route";

const mockedAuthorize = authorizeAppointment as jest.Mock;
const mockedFindThread = prisma.appointmentSupportThread
  .findUnique as jest.Mock;
const mockedBuildContext = buildSupportContext as jest.Mock;
const mockedRunTurn = runSupportTurn as jest.Mock;

const SLUG = "demo0813-appt-ba";

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest(`https://x.test/api/appointments/${SLUG}/support`, {
    method,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuthorize.mockResolvedValue({
    userId: "u1",
    isOrgParty: false,
    organizationId: null,
    detail: {},
  });
  mockedFindThread.mockResolvedValue(null);
  mockedBuildContext.mockResolvedValue(null);
});

describe("GET /api/appointments/[appointmentId]/support", () => {
  it("REGRESSION: accepts seeded slug ids the old .uuid() gate rejected", async () => {
    const res = await GET(req("GET"), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(res.status).toBe(200);
    expect(mockedAuthorize).toHaveBeenCalledWith(SLUG, true);
    const json = await res.json();
    expect(json.data).toBeNull();
    expect(json.intents).toEqual([]);
  });

  it("accepts uuid ids identically", async () => {
    const uuid = "329c0b89-0648-4f8e-82a4-25811cdea440";
    const res = await GET(req("GET"), {
      params: Promise.resolve({ appointmentId: uuid }),
    });
    expect(res.status).toBe(200);
    expect(mockedAuthorize).toHaveBeenCalledWith(uuid, true);
  });

  it("400 INVALID_ID envelope on an over-long id — garbage never reaches Prisma", async () => {
    const long = "x".repeat(65);
    const res = await GET(req("GET"), {
      params: Promise.resolve({ appointmentId: long }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_ID");
    expect(json.detail).toBeDefined();
    expect(mockedAuthorize).not.toHaveBeenCalled();
    expect(mockedFindThread).not.toHaveBeenCalled();
  });

  it("maps a coded FORBIDDEN through the envelope", async () => {
    mockedAuthorize.mockResolvedValue({ code: "FORBIDDEN", status: 403 });
    const res = await GET(req("GET"), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("FORBIDDEN");
    expect(typeof json.error).toBe("string");
  });
});

describe("POST /api/appointments/[appointmentId]/support", () => {
  it("advances a turn for a slug id and returns the result", async () => {
    mockedRunTurn.mockResolvedValue({
      messages: [{ sender: "BOT", body: "Pick an option" }],
      nextNodeId: "n2",
      actions: [],
    });
    const res = await POST(req("POST", { category: "CANCEL_REFUND" }), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(res.status).toBe(200);
    expect(mockedRunTurn).toHaveBeenCalledWith(
      SLUG,
      "u1",
      expect.objectContaining({ category: "CANCEL_REFUND", isOrgParty: false }),
    );
  });

  it("allows normal multi-turn conversations while guarding against automated spam bursts", async () => {
    mockedRunTurn.mockResolvedValue({
      messages: [],
      nextNodeId: null,
      actions: [],
    });
    for (let i = 0; i < 6; i++) {
      const res = await POST(req("POST", { userMessage: `turn ${i}` }), {
        params: Promise.resolve({ appointmentId: SLUG }),
      });
      expect(res.status).toBe(200);
    }
    expect(mockedRunTurn).toHaveBeenCalledTimes(6);
    expect(applyRateLimit).toHaveBeenCalledTimes(6);
    expect(applyRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "appt-support:u1",
    );
  });

  it("passes the customer's urgent flag through to the hand-off", async () => {
    mockedRunTurn.mockResolvedValue({ messages: [], actions: [] });
    await POST(
      req("POST", {
        category: "OTHER",
        userMessage: "the audio kept cutting out",
        urgent: true,
      }),
      { params: Promise.resolve({ appointmentId: SLUG }) },
    );
    expect(mockedRunTurn).toHaveBeenCalledWith(
      SLUG,
      "u1",
      expect.objectContaining({ category: "OTHER", urgent: true }),
    );
  });

  it("VALIDATION_FAILED envelope when the turn has nothing actionable", async () => {
    const res = await POST(req("POST", {}), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION_FAILED");
    expect(mockedRunTurn).not.toHaveBeenCalled();
  });

  it("NOT_FOUND envelope when the resolver cannot find the appointment", async () => {
    mockedRunTurn.mockResolvedValue(null);
    const res = await POST(req("POST", { userMessage: "hello?" }), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("NOT_FOUND");
  });
});
