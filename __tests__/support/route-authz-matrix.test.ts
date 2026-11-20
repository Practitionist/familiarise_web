/** @jest-environment node */
/**
 * Authorization matrix for every support route handler. The real guards run
 * (requireApiAuth, requireBackofficeSurface, requireOrgAccess, case-access,
 * attachment access, appointment access) over an in-memory Prisma fake that
 * honours `where` filters; only the session source, storage, notifications
 * and the heavy write services are stubbed. Each row asserts the outcome
 * class a persona gets, never the response body.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  setTag: jest.fn(),
  setTags: jest.fn(),
  setContext: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn(async () => true),
  metrics: { count: jest.fn(), distribution: jest.fn() },
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

jest.mock("next/headers", () => ({
  __esModule: true,
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));

// Mirrors lib/auth-server's getSession: an operator without 2FA reads as signed
// out unless the caller (lookupSession, behind requireApiAuth) opts in.
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: async ({ allowUnenrolledOperator = false } = {}) => {
    const user = mockAuth.user;
    if (!user) return null;
    const operator = user.role === "ADMIN" || user.role === "STAFF";
    if (operator && user.twoFactorEnabled !== true && !allowUnenrolledOperator)
      return null;
    return { user, session: { id: `s-${user.id}`, userId: user.id } };
  },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockPrismaClient(),
  ALLOCATION_TX_MAX_WAIT_MS: 5000,
  ALLOCATION_TX_TIMEOUT_MS: 15000,
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  spamLimiter: {},
  supportTurnLimiter: {},
  documentUploadLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));

jest.mock("../../lib/supabase-storage-core", () => ({
  __esModule: true,
  adminStorage: () => ({
    from: () => ({
      createSignedUrl: async () => ({
        data: { signedUrl: "https://storage.test/signed" },
        error: null,
      }),
      createSignedUploadUrl: async () => ({
        data: {
          signedUrl: "https://storage.test/upload",
          token: "tok",
          path: "p",
        },
        error: null,
      }),
      info: async () => ({ data: null, error: new Error("missing") }),
    }),
  }),
  ensureBucketExists: async () => true,
  removeObjects: async () => undefined,
}));

jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifySupportTicketUpdate: jest.fn(async () => null),
  notifySupportTicketCreated: jest.fn(async () => ({ success: true })),
  notifySupportTicketActivity: jest.fn(async () => []),
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  __esModule: true,
  stageBell: jest.fn(async () => null),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  __esModule: true,
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
jest.mock("../../lib/email/deliver", () => ({
  __esModule: true,
  stage: jest.fn(async () => []),
}));
jest.mock("../../lib/email/senders/people", () => ({
  __esModule: true,
  stageSupportTicketUpdateEmail: jest.fn(async () => []),
}));
jest.mock("../../lib/support/external-requester", () => ({
  __esModule: true,
  confirmExternalRequesterEmail: jest.fn(async () => "VERIFIED"),
  stageExternalRequesterEmail: jest.fn(async () => null),
}));
jest.mock("../../lib/support/reference", () => ({
  __esModule: true,
  allocateTicketReference: jest.fn(async () => "FAM-2026-000099"),
}));
jest.mock("../../lib/support/case-holds", () => ({
  __esModule: true,
  caseHoldEvents: jest.fn(async () => []),
  activeHolds: jest.fn(() => []),
  holdPaymentForCase: jest.fn(),
  releaseCaseHoldRows: jest.fn(),
  releaseAllCaseHolds: jest.fn(async () => []),
}));

// Readers and guards stay real; the multi-table writers behind a passed guard are stubbed.
jest.mock("../../lib/support/case-service", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("../../lib/support/case-service")>(
    "../../lib/support/case-service",
  ),
  createOrReuseSupportCase: jest.fn(
    async (input: {
      requesterUserId: string;
      submitterUserId: string;
      organizationId?: string | null;
      ownershipScope?: string;
    }) => {
      const row = {
        ...mockCaseRow("case-new"),
        requesterUserId: input.requesterUserId,
        submitterUserId: input.submitterUserId,
        organizationId: input.organizationId ?? null,
        ownershipScope: input.ownershipScope ?? "PERSONAL",
      };
      mockTable("supportCase").push(row);
      return { supportCase: row, reused: false };
    },
  ),
  appendSupportCaseTurn: jest.fn(async () => ({
    ok: true,
    messages: [],
    replayed: false,
  })),
  patchSupportCaseLifecycle: jest.fn(async () => ({
    ok: true,
    previousStatus: "IN_PROGRESS",
    supportCase: mockCaseRow("case-personal"),
  })),
}));
jest.mock("../../lib/support/case-notice", () => ({
  stageCaseNotice: jest.fn(async () => undefined),
}));
jest.mock("../../lib/support/case-actions", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("../../lib/support/case-actions")>(
    "../../lib/support/case-actions",
  ),
  quoteCaseRefund: jest.fn(async () => ({
    refundablePaise: 1000,
    rail: "GATEWAY",
    blocked: null,
    committedPaise: 0,
  })),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/backoffice/refund-doors", () => ({
  __esModule: true,
  refundInFlightOr: jest.fn(),
}));
// The audited ops doors own their surface, step-up and budget checks (covered by
// the backoffice suites); here the route's delegation to them is what is asserted.
jest.mock("../../lib/support/refund-door", () => ({
  __esModule: true,
  reviewSupportRefundDoor: jest.fn(async () => mockDoorResponse()),
  rethrowCaseRefusal: jest.fn(),
}));
jest.mock("../../lib/support/case-doors", () => ({
  __esModule: true,
  applySupportHoldDoor: jest.fn(async () => mockDoorResponse()),
  releaseSupportHoldDoor: jest.fn(async () => mockDoorResponse()),
  voidSupportRecommendationDoor: jest.fn(async () => mockDoorResponse()),
}));

// Chat-access doors own their surface, step-up and audit (covered by chat-doors.test.ts).
jest.mock("../../lib/support/chat-doors", () => ({
  __esModule: true,
  openChatReadDoor: jest.fn(async () => mockDoorResponse()),
  startInterventionDoor: jest.fn(async () => mockDoorResponse()),
  endChatReadDoor: jest.fn(async () => mockDoorResponse()),
  endInterventionDoor: jest.fn(async () => mockDoorResponse()),
}));
jest.mock("../../lib/support/chat-transcript", () => ({
  __esModule: true,
  readTranscriptPage: jest.fn(async () => ({
    messages: [],
    nextBefore: null,
    windowStart: new Date(0).toISOString(),
  })),
}));
jest.mock("../../lib/stream/support-intervention", () => ({
  __esModule: true,
  probeSupportChannel: jest.fn(async () => ({ exists: true, frozen: false })),
  postSupportMessage: jest.fn(async () => ({
    messageId: "fs-grant-1-draft_0001",
    replayed: false,
  })),
}));

jest.mock("../../lib/support/service", () => ({
  __esModule: true,
  runSupportTurn: jest.fn(async () => ({
    messages: [],
    actions: [],
    nextNodeId: null,
  })),
  ORG_PARTY_CATEGORIES: new Set(["ORG_ADMIN_DISPUTE", "SPONSORSHIP_BILLING"]),
}));
jest.mock("../../lib/support/context", () => ({
  __esModule: true,
  buildSupportContext: jest.fn(async () => null),
}));
jest.mock("../../lib/data/appointment-detail", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("../../lib/data/appointment-detail")>(
    "../../lib/data/appointment-detail",
  ),
  readAppointmentDetail: jest.fn(async () => mockAppointmentDetail()),
}));
jest.mock("../../lib/support/create-ticket", () => ({
  __esModule: true,
  createSupportTicket: jest.fn(async () => ({
    id: "ticket-1",
    referenceNumber: "FAM-2026-000100",
    ackDueAt: null,
  })),
  findRecentOpenEscalation: jest.fn(async () => null),
  raiseReusedTicketToHigh: jest.fn(async () => undefined),
  createOutboundStaffSupportTicket: jest.fn(async () => ({ id: "ticket-2" })),
}));

import { NextRequest } from "next/server";
import { applySupportHoldDoor } from "../../lib/support/case-doors";
import { confirmExternalRequesterEmail } from "../../lib/support/external-requester";
import * as appointmentSupport from "../../app/api/appointments/[appointmentId]/support/route";
import * as appeals from "../../app/api/support/appeals/route";
import * as attachment from "../../app/api/support/attachments/[attachmentId]/route";
import * as caseActions from "../../app/api/support/cases/[caseId]/actions/route";
import * as caseAttachments from "../../app/api/support/cases/[caseId]/attachments/route";
import * as caseChat from "../../app/api/support/cases/[caseId]/chat/route";
import * as caseChatMessages from "../../app/api/support/cases/[caseId]/chat/messages/route";
import * as caseChatTranscript from "../../app/api/support/cases/[caseId]/chat/transcript/route";
import * as caseCsat from "../../app/api/support/cases/[caseId]/csat/route";
import * as caseMessages from "../../app/api/support/cases/[caseId]/messages/route";
import * as caseReceipt from "../../app/api/support/cases/[caseId]/receipt/route";
import * as refundPreview from "../../app/api/support/cases/[caseId]/recommendations/[recommendationId]/preview/route";
import * as caseDetail from "../../app/api/support/cases/[caseId]/route";
import * as cases from "../../app/api/support/cases/route";
import * as evidenceDetail from "../../app/api/support/evidence/[requestId]/route";
import * as evidenceList from "../../app/api/support/evidence/route";
import * as externalVerify from "../../app/api/support/external-verify/route";
import * as flowRating from "../../app/api/support/flow-outcomes/[id]/rating/route";
import * as platform from "../../app/api/support/platform/route";
import * as ownRequest from "../../app/api/support/requests/[caseKey]/route";
import * as requests from "../../app/api/support/requests/route";
import * as tickets from "../../app/api/support/tickets/route";

// ---------------------------------------------------------------------------
// In-memory Prisma: every model is an array of rows; `where` is evaluated.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
interface QueryArgs {
  where?: unknown;
  data?: Row;
  create?: Row;
  update?: Row;
}

const mockTables: Record<string, Row[]> = {};
const mockAuth: { user: Row | null } = { user: null };

const FIELD_OPERATORS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "some",
  "none",
  "every",
  "contains",
  "mode",
]);

function mockTable(name: string): Row[] {
  mockTables[name] ??= [];
  return mockTables[name];
}

function mockIsRecord(value: unknown): value is Row {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Date) &&
    !Array.isArray(value)
  );
}

function mockComparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function mockPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function mockSame(a: unknown, b: unknown): boolean {
  return mockComparable(a) === mockComparable(b);
}

function mockOperator(
  value: unknown,
  op: string,
  arg: unknown,
  row: Row,
): boolean {
  const list = Array.isArray(value) ? value : [];
  const v = mockComparable(value);
  const a = mockComparable(arg);
  switch (op) {
    case "equals":
      return mockSame(value, arg);
    case "not":
      return !mockField(value, arg, row);
    case "in":
      return Array.isArray(arg) && arg.some((x) => mockSame(value, x));
    case "notIn":
      return Array.isArray(arg) && !arg.some((x) => mockSame(value, x));
    case "lt":
      return mockPresent(v) && mockPresent(a) && Number(v) < Number(a);
    case "lte":
      return mockPresent(v) && mockPresent(a) && Number(v) <= Number(a);
    case "gt":
      return mockPresent(v) && mockPresent(a) && Number(v) > Number(a);
    case "gte":
      return mockPresent(v) && mockPresent(a) && Number(v) >= Number(a);
    case "some":
      return list.some((item) => mockMatches(item, arg));
    case "none":
      return !list.some((item) => mockMatches(item, arg));
    case "every":
      return list.every((item) => mockMatches(item, arg));
    case "contains":
      return typeof value === "string" && value.includes(String(arg));
    default:
      return true;
  }
}

function mockField(value: unknown, cond: unknown, row: Row): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null || value === undefined;
  if (!mockIsRecord(cond)) return mockSame(value, cond);
  const keys = Object.keys(cond);
  if (keys.length > 0 && keys.every((key) => FIELD_OPERATORS.has(key)))
    return keys.every((key) => mockOperator(value, key, cond[key], row));
  // A compound unique key (`userId_organizationId`) names fields on the row itself.
  if (value === undefined) return mockMatches(row, cond);
  if (Array.isArray(value))
    return value.some((item) => mockMatches(item, cond));
  return mockIsRecord(value) && mockMatches(value, cond);
}

function mockMatches(row: unknown, where: unknown): boolean {
  if (!mockIsRecord(where)) return true;
  if (!mockIsRecord(row)) return false;
  return Object.entries(where).every(([key, cond]) => {
    const all = Array.isArray(cond) ? cond : [cond];
    if (key === "AND") return all.every((w) => mockMatches(row, w));
    if (key === "OR") return all.some((w) => mockMatches(row, w));
    if (key === "NOT") return all.every((w) => !mockMatches(row, w));
    return mockField(row[key], cond, row);
  });
}

function mockScalarData(data: Row | undefined): Row {
  return Object.fromEntries(
    Object.entries(data ?? {}).filter(
      ([, value]) =>
        !(mockIsRecord(value) && ("create" in value || "connect" in value)),
    ),
  );
}

function mockModel(name: string) {
  const find = (args?: QueryArgs) =>
    mockTable(name).find((row) => mockMatches(row, args?.where)) ?? null;
  const filter = (args?: QueryArgs) =>
    mockTable(name).filter((row) => mockMatches(row, args?.where));
  const create = (data: Row | undefined) => {
    const row: Row = {
      id: `${name}-${mockTable(name).length + 1}`,
      status: "OPEN",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...mockScalarData(data),
    };
    mockTable(name).push(row);
    return row;
  };
  return {
    findFirst: async (args?: QueryArgs) => find(args),
    findUnique: async (args?: QueryArgs) => find(args),
    findFirstOrThrow: async (args?: QueryArgs) => {
      const row = find(args);
      if (!row) throw new Error(`${name} not found`);
      return row;
    },
    findMany: async (args?: QueryArgs) => filter(args),
    count: async (args?: QueryArgs) => filter(args).length,
    create: async (args: QueryArgs) => create(args.data),
    updateMany: async (args: QueryArgs) => {
      const hit = filter(args);
      for (const row of hit) Object.assign(row, mockScalarData(args.data));
      return { count: hit.length };
    },
    update: async (args: QueryArgs) => {
      const row = find(args);
      if (!row) throw new Error(`${name} not found`);
      return Object.assign(row, mockScalarData(args.data));
    },
    upsert: async (args: QueryArgs) => {
      const row = find(args);
      return row
        ? Object.assign(row, mockScalarData(args.update))
        : create(args.create);
    },
  };
}

function mockPrismaClient(): unknown {
  const client: unknown = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== "string" || prop === "then") return undefined;
        if (prop === "$transaction")
          return async (arg: unknown) =>
            typeof arg === "function"
              ? (arg as (tx: unknown) => unknown)(client)
              : Promise.all(Array.isArray(arg) ? arg : []);
        if (prop.startsWith("$")) return async () => [];
        return mockModel(prop);
      },
    },
  );
  return client;
}

function mockDoorResponse(): Response {
  return Response.json({ door: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

function mockCaseRow(id: string): Row {
  return {
    id,
    referenceNumber: "FAM-2026-000001",
    title: "Refund not received",
    description: "My refund never arrived.",
    category: "OTHER",
    issueType: null,
    priority: "NORMAL",
    caseKind: "INCIDENT",
    activeChannel: "HUMAN",
    status: "IN_PROGRESS",
    ownershipScope: "PERSONAL",
    organizationId: null,
    requesterUserId: "u-owner",
    submitterUserId: "u-owner",
    externalRequesterEmail: null,
    appointmentId: "appt-1",
    appointmentOccurrenceId: null,
    appealOfDecisionId: null,
    appealOfModerationActionId: null,
    assignedToId: null,
    callbackPhone: null,
    callbackWindow: null,
    csatRating: null,
    csatAt: null,
    ackDueAt: null,
    acknowledgedAt: null,
    resolutionDueAt: null,
    resolvedAt: null,
    closedAt: null,
    deletedAt: null,
    lastMessageAt: null,
    createdAt: new Date(Date.now() - 2 * DAY),
    updatedAt: new Date(Date.now() - DAY),
    messages: [],
    events: [],
    subjects: [],
    decisions: [],
    organization: null,
    appointment: null,
  };
}

function mockAppointmentDetail() {
  return {
    appointment: {
      id: "appt-1",
      appointmentType: "CONSULTATION",
      organizationId: "org-1",
      webinarId: null,
      classId: null,
      participants: [],
      payment: [],
      consultation: {
        requestedBy: { userId: "u-owner" },
        consultationPlan: { consultantProfile: { userId: "u-expert" } },
      },
    },
  };
}

const USERS = {
  owner: { id: "u-owner", role: "CONSULTEE" },
  expert: { id: "u-expert", role: "CONSULTANT" },
  other: { id: "u-other", role: "CONSULTEE" },
  orgOwner: { id: "u-org-owner", role: "CONSULTEE" },
  orgManager: { id: "u-org-manager", role: "CONSULTEE" },
  orgBilling: { id: "u-org-billing", role: "CONSULTEE" },
  orgLearner: { id: "u-org-learner", role: "CONSULTEE" },
  staff: { id: "u-staff", role: "STAFF", twoFactorEnabled: true },
  admin: { id: "u-admin", role: "ADMIN", twoFactorEnabled: true },
  staffNo2fa: { id: "u-staff-no2fa", role: "STAFF", twoFactorEnabled: false },
} as const;

type SignedIn = keyof typeof USERS;
type Persona = SignedIn | "anonymous";
type Outcome = 400 | 401 | 403 | 404 | 409 | 428 | "pass";
type Matrix = Partial<Record<Persona, Outcome>>;

const MEMBER_ROLES: Partial<Record<SignedIn, string>> = {
  orgOwner: "OWNER",
  orgManager: "MANAGER",
  orgBilling: "BILLING_ADMIN",
  orgLearner: "LEARNER",
};

function seed() {
  for (const key of Object.keys(mockTables)) delete mockTables[key];
  const personal = mockCaseRow("case-personal");
  const orgOps = {
    ...mockCaseRow("case-org-ops"),
    ownershipScope: "ORG_OPERATIONS",
    organizationId: "org-1",
    requesterUserId: "u-org-owner",
    submitterUserId: "u-org-owner",
    appointmentId: null,
  };
  const orgBilling = {
    ...mockCaseRow("case-org-billing"),
    ownershipScope: "ORG_BILLING",
    organizationId: "org-1",
    requesterUserId: "u-org-billing",
    submitterUserId: "u-org-billing",
    appointmentId: null,
  };
  mockTable("supportCase").push(personal, orgOps, orgBilling);
  mockTable("user").push(
    ...Object.values(USERS).map((u) => ({
      id: u.id,
      role: u.role,
      name: u.id,
      banned: false,
    })),
  );
  mockTable("organization").push({
    id: "org-1",
    status: "ACTIVE",
    canSponsor: true,
    canHost: true,
    billingAccount: null,
  });
  for (const [persona, role] of Object.entries(MEMBER_ROLES))
    mockTable("membership").push({
      id: `m-${persona}`,
      userId: USERS[persona as SignedIn].id,
      organizationId: "org-1",
      role,
      status: "ACTIVE",
    });
  mockTable("appointment").push({
    id: "appt-1",
    participants: [
      {
        userId: "u-expert",
        organizationId: null,
        role: "CONSULTANT",
        status: "CONFIRMED",
      },
    ],
    payment: [{ userId: "u-owner", hostOrganizationId: null }],
    occurrences: [],
    // Hosted by org-1, so its operators hold the org-party support grant.
    organizationId: "org-1",
    consultation: { consultationPlan: { organizationId: "org-1" } },
    organization: { status: "ACTIVE" },
  });
  mockTable("supportCaseEvidenceRequest").push({
    id: "ev-1",
    caseId: "case-personal",
    recipientUserId: "u-expert",
    requestedById: "u-staff",
    prompt: "Describe what happened.",
    dueAt: new Date(Date.now() + DAY),
    responseBody: null,
    responseClientId: null,
    respondedAt: null,
    cancelledAt: null,
    createdAt: new Date(Date.now() - DAY),
    supportCase: personal,
  });
  mockTable("supportCaseDecision").push({
    id: "dec-1",
    caseId: "case-personal",
    outcome: "NO_REMEDY",
    decidedById: "u-staff",
    appealUntil: new Date(Date.now() + 10 * DAY),
    createdAt: new Date(Date.now() - DAY),
    supersededBy: null,
    supportCase: personal,
  });
  const attachmentBase = {
    caseId: "case-personal",
    uploadedById: "u-owner",
    originalName: "receipt.pdf",
    mimeType: "application/pdf",
    fileSize: 100,
    messageId: null,
    message: null,
    evidenceRequestId: null,
    deletedAt: null,
    supportCase: { decisions: [], status: "IN_PROGRESS" },
  };
  mockTable("supportCaseAttachment").push(
    {
      ...attachmentBase,
      id: "att-1",
      storagePath: "support-cases/case-personal/att-1",
      completedAt: new Date(Date.now() - DAY),
    },
    {
      ...attachmentBase,
      id: "att-pending",
      storagePath: "support-cases/case-personal/att-pending",
      completedAt: null,
    },
  );
  mockTable("supportFinancialRecommendation").push({
    id: "rec-1",
    caseId: "case-personal",
    amountPaise: 1000,
  });
  mockTable("supportFlowOutcome").push({
    id: "fo-1",
    userId: "u-owner",
    helpfulRating: null,
  });
}

function signIn(persona: Persona) {
  mockAuth.user =
    persona === "anonymous"
      ? null
      : {
          twoFactorEnabled: false,
          banned: false,
          name: persona,
          email: `${persona}@example.test`,
          ...USERS[persona],
        };
}

function personalCase(): Row {
  const row = mockTable("supportCase").find((c) => c.id === "case-personal");
  if (!row) throw new Error("fixture missing");
  return row;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function request(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`https://app.test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

function params<T>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

/**
 * The outcome a response represents when it matches `expected`, else its status
 * and body for the failure diff. "pass" means the guards admitted the caller
 * and the handler answered 2xx/3xx.
 */
async function outcomeOf(res: Response, expected: Outcome): Promise<string> {
  const ok = expected === "pass" ? res.status < 400 : res.status === expected;
  return ok ? String(expected) : `${res.status}: ${await res.text()}`;
}

interface HandlerCase {
  name: string;
  call: () => Promise<Response> | Response;
  matrix: Matrix;
  setup?: (persona: Persona) => void;
}

function rows(matrix: Matrix): [Persona, Outcome][] {
  return Object.entries(matrix).flatMap(([persona, outcome]) =>
    outcome === undefined ? [] : [[persona as Persona, outcome]],
  );
}

const caseParams = (caseId = "case-personal") => params({ caseId });
const BASE_CASE_BODY = {
  title: "Help",
  description: "Something broke",
  category: "OTHER",
};

beforeEach(() => {
  seed();
  signIn("anonymous");
});

// Mapping guards (requireApiAuth / requireBackofficeSurface) return these for
// every handler that uses them; asserted per row below.
const AUTHED = { anonymous: 401, staffNo2fa: 428 } as const;

const HANDLERS: HandlerCase[] = [
  {
    name: "GET /api/appointments/[appointmentId]/support",
    call: () =>
      appointmentSupport.GET(
        request("GET", "/api/appointments/appt-1/support"),
        params({ appointmentId: "appt-1" }),
      ),
    matrix: {
      anonymous: 401,
      owner: "pass",
      expert: "pass",
      other: 403,
      orgManager: "pass",
      orgBilling: 403,
      orgLearner: 403,
      staff: "pass",
      admin: "pass",
      staffNo2fa: 428,
    },
  },
  {
    name: "POST /api/appointments/[appointmentId]/support",
    call: () =>
      appointmentSupport.POST(
        request("POST", "/api/appointments/appt-1/support", {
          userMessage: "The call never connected",
        }),
        params({ appointmentId: "appt-1" }),
      ),
    matrix: {
      anonymous: 401,
      owner: "pass",
      expert: "pass",
      other: 403,
      orgManager: "pass",
      orgBilling: 403,
      orgLearner: 403,
      staff: "pass",
      admin: "pass",
      staffNo2fa: 428,
    },
  },
  {
    name: "POST /api/support/appeals",
    call: () =>
      appeals.POST(
        request("POST", "/api/support/appeals", {
          decisionId: "dec-1",
          reason: "The decision missed my evidence",
          clientIntakeId: "intake-1",
        }),
      ),
    // Only a correspondent or an evidence party may appeal; operators review appeals.
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: "pass",
      other: 404,
      orgOwner: 404,
      staff: 404,
      admin: 404,
    },
  },
  {
    name: "GET /api/support/attachments/[attachmentId]",
    call: () =>
      attachment.GET(
        request("GET", "/api/support/attachments/att-1"),
        params({ attachmentId: "att-1" }),
      ),
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: 404,
      other: 404,
      orgOwner: 404,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "DELETE /api/support/attachments/[attachmentId]",
    call: () =>
      attachment.DELETE(
        request("DELETE", "/api/support/attachments/att-pending"),
        params({ attachmentId: "att-pending" }),
      ),
    // Only the uploader may withdraw a pending upload.
    matrix: {
      ...AUTHED,
      owner: "pass",
      other: 404,
      expert: 404,
      staff: 404,
      admin: 404,
    },
  },
  {
    name: "GET /api/support/cases/[caseId]/actions",
    call: () =>
      caseActions.GET(
        request("GET", "/api/support/cases/case-personal/actions"),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: 404,
      other: 404,
      orgOwner: 404,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/cases/[caseId]/actions (REQUEST_EVIDENCE)",
    call: () =>
      caseActions.POST(
        request("POST", "/api/support/cases/case-personal/actions", {
          action: "REQUEST_EVIDENCE",
          clientActionId: "ca-1",
          expectedUpdatedAt: new Date().toISOString(),
          recipientUserId: "u-expert",
          prompt: "Explain",
        }),
        caseParams(),
      ),
    // A replayed request keeps the authorized path free of the evidence writer.
    setup: (persona) => {
      if (persona === "anonymous") return;
      mockTable("supportCaseEvidenceRequest").push({
        id: "ev-replay",
        caseId: "case-personal",
        clientActionId: "ca-1",
        recipientUserId: "u-expert",
        prompt: "Explain",
        requestedById: USERS[persona].id,
      });
    },
    matrix: {
      ...AUTHED,
      owner: 403,
      expert: 403,
      other: 403,
      orgOwner: 403,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "GET /api/support/cases/[caseId]/attachments",
    call: () =>
      caseAttachments.GET(
        request("GET", "/api/support/cases/case-personal/attachments"),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: 404,
      other: 404,
      orgOwner: 404,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "GET /api/support/cases/[caseId]/attachments?evidenceRequestId",
    call: () =>
      caseAttachments.GET(
        request(
          "GET",
          "/api/support/cases/case-personal/attachments?evidenceRequestId=ev-1",
        ),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: 404,
      expert: "pass",
      other: 404,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/cases/[caseId]/attachments",
    call: () =>
      caseAttachments.POST(
        request("POST", "/api/support/cases/case-personal/attachments", {
          originalName: "receipt.pdf",
          mimeType: "application/pdf",
          fileSize: 100,
        }),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: 404,
      other: 404,
      orgOwner: 404,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/cases/[caseId]/attachments (evidence response)",
    call: () =>
      caseAttachments.POST(
        request("POST", "/api/support/cases/case-personal/attachments", {
          originalName: "notes.pdf",
          mimeType: "application/pdf",
          fileSize: 100,
          evidenceRequestId: "ev-1",
        }),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: 404,
      expert: "pass",
      other: 404,
      staff: "pass",
    },
  },
  {
    name: "PUT /api/support/cases/[caseId]/attachments",
    call: () =>
      caseAttachments.PUT(
        request("PUT", "/api/support/cases/case-personal/attachments", {
          attachmentId: "att-1",
        }),
        caseParams(),
      ),
    // Only the uploader confirms their own upload.
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: 404,
      other: 404,
      staff: 404,
      admin: 404,
    },
  },
  {
    name: "GET /api/support/cases/[caseId]/chat",
    call: () =>
      caseChat.GET(
        request("GET", "/api/support/cases/case-personal/chat"),
        caseParams(),
      ),
    // Org admins never reach a booking chat; operators only.
    matrix: {
      ...AUTHED,
      owner: 403,
      expert: 403,
      other: 403,
      orgOwner: 403,
      orgManager: 403,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/cases/[caseId]/chat (OPEN_READ)",
    call: () =>
      caseChat.POST(
        request("POST", "/api/support/cases/case-personal/chat", {
          action: "OPEN_READ",
          reason: "Reported messages",
        }),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: 403,
      expert: 403,
      other: 403,
      orgOwner: 403,
      orgManager: 403,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/cases/[caseId]/chat (END_INTERVENTION)",
    call: () =>
      caseChat.POST(
        request("POST", "/api/support/cases/case-personal/chat", {
          action: "END_INTERVENTION",
          grantId: "grant-1",
          reason: "Evidence received",
        }),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: 403,
      expert: 403,
      orgOwner: 403,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/cases/[caseId]/chat (malformed body)",
    call: () =>
      caseChat.POST(
        request("POST", "/api/support/cases/case-personal/chat", {
          action: "WATCH",
        }),
        caseParams(),
      ),
    // Authorization runs before the body is read.
    matrix: { ...AUTHED, owner: 403, staff: 400, admin: 400 },
  },
  {
    name: "GET /api/support/cases/[caseId]/chat/transcript",
    call: () =>
      caseChatTranscript.GET(
        request(
          "GET",
          "/api/support/cases/case-personal/chat/transcript?grantId=grant-1",
        ),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: 403,
      expert: 403,
      other: 403,
      orgOwner: 403,
      orgManager: 403,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/cases/[caseId]/chat/messages",
    call: () =>
      caseChatMessages.POST(
        request("POST", "/api/support/cases/case-personal/chat/messages", {
          grantId: "grant-1",
          clientActionId: "draft_0001",
          text: "Please share the receipt here.",
        }),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: 403,
      expert: 403,
      other: 403,
      orgOwner: 403,
      orgManager: 403,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/cases/[caseId]/csat",
    call: () =>
      caseCsat.POST(
        request("POST", "/api/support/cases/case-personal/csat", {
          rating: 5,
        }),
        caseParams(),
      ),
    setup: () => {
      Object.assign(personalCase(), {
        status: "RESOLVED",
        resolvedAt: new Date(Date.now() - DAY),
      });
    },
    // Only the customer side rates; operators read CSAT, never cast it.
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: 404,
      other: 404,
      orgOwner: 404,
      staff: 404,
      admin: 404,
    },
  },
  {
    name: "POST /api/support/cases/[caseId]/messages",
    call: () =>
      caseMessages.POST(
        request("POST", "/api/support/cases/case-personal/messages", {
          body: "Still broken",
        }),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: 404,
      other: 404,
      orgOwner: 404,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/cases/[caseId]/messages (isInternal)",
    call: () =>
      caseMessages.POST(
        request("POST", "/api/support/cases/case-personal/messages", {
          body: "Internal note",
          isInternal: true,
        }),
        caseParams(),
      ),
    matrix: { ...AUTHED, owner: 403, other: 404, staff: "pass" },
  },
  {
    name: "GET /api/support/cases/[caseId]/messages",
    call: () =>
      caseMessages.GET(
        request("GET", "/api/support/cases/case-personal/messages"),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: 404,
      other: 404,
      orgOwner: 404,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "GET /api/support/cases/[caseId]/receipt",
    call: () =>
      caseReceipt.GET(
        request("GET", "/api/support/cases/case-personal/receipt"),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: 404,
      other: 404,
      orgOwner: 404,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "GET /api/support/cases/[caseId]/recommendations/[recommendationId]/preview",
    call: () =>
      refundPreview.GET(
        request(
          "GET",
          "/api/support/cases/case-personal/recommendations/rec-1/preview",
        ),
        params({ caseId: "case-personal", recommendationId: "rec-1" }),
      ),
    matrix: {
      ...AUTHED,
      owner: 403,
      expert: 403,
      other: 403,
      orgOwner: 403,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "GET /api/support/cases/[caseId]",
    call: () =>
      caseDetail.GET(
        request("GET", "/api/support/cases/case-personal"),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: 404,
      other: 404,
      orgOwner: 404,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "PATCH /api/support/cases/[caseId]",
    call: () =>
      caseDetail.PATCH(
        request("PATCH", "/api/support/cases/case-personal", {
          expectedUpdatedAt: new Date().toISOString(),
          status: "IN_PROGRESS",
        }),
        caseParams(),
      ),
    matrix: {
      ...AUTHED,
      owner: 403,
      expert: 403,
      other: 403,
      orgOwner: 403,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "PATCH /api/support/cases/[caseId] (legalHold)",
    call: () =>
      caseDetail.PATCH(
        request("PATCH", "/api/support/cases/case-personal", {
          expectedUpdatedAt: new Date().toISOString(),
          legalHold: true,
        }),
        caseParams(),
      ),
    matrix: { ...AUTHED, owner: 403, staff: 403, admin: "pass" },
  },
  {
    name: "GET /api/support/cases",
    call: () => cases.GET(request("GET", "/api/support/cases")),
    matrix: {
      ...AUTHED,
      owner: "pass",
      other: "pass",
      orgManager: "pass",
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/cases",
    call: () =>
      cases.POST(request("POST", "/api/support/cases", BASE_CASE_BODY)),
    matrix: {
      ...AUTHED,
      owner: "pass",
      other: "pass",
      orgLearner: "pass",
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "GET /api/support/evidence/[requestId]",
    call: () =>
      evidenceDetail.GET(
        request("GET", "/api/support/evidence/ev-1"),
        params({ requestId: "ev-1" }),
      ),
    matrix: {
      ...AUTHED,
      owner: 404,
      expert: "pass",
      other: 404,
      orgOwner: 404,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/evidence/[requestId]",
    call: () =>
      evidenceDetail.POST(
        request("POST", "/api/support/evidence/ev-1", {
          body: "Here is what happened",
          clientTurnId: "turn-1",
        }),
        params({ requestId: "ev-1" }),
      ),
    // Only the named recipient answers an evidence request.
    matrix: {
      ...AUTHED,
      owner: 404,
      expert: "pass",
      other: 404,
      staff: 404,
      admin: 404,
    },
  },
  {
    name: "GET /api/support/evidence",
    call: () => evidenceList.GET(request("GET", "/api/support/evidence")),
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: "pass",
      other: "pass",
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "GET /api/support/evidence?organizationId",
    call: () =>
      evidenceList.GET(
        request("GET", "/api/support/evidence?organizationId=org-1"),
      ),
    // Any active member reads; a platform ADMIN gets the read-only stub.
    matrix: {
      ...AUTHED,
      orgOwner: "pass",
      orgLearner: "pass",
      other: 403,
      staff: 403,
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/flow-outcomes/[id]/rating",
    call: () =>
      flowRating.POST(
        request("POST", "/api/support/flow-outcomes/fo-1/rating", {
          rating: 4,
        }),
        params({ id: "fo-1" }),
      ),
    // requireApiSession carries no 2FA precondition; the outcome row is scoped to its user.
    matrix: {
      anonymous: 401,
      owner: "pass",
      other: 409,
      staff: 409,
      staffNo2fa: 409,
    },
  },
  {
    name: "GET /api/support/platform",
    call: () => platform.GET(),
    matrix: {
      anonymous: 401,
      owner: "pass",
      orgManager: "pass",
      staff: "pass",
      admin: "pass",
      staffNo2fa: 428,
    },
  },
  {
    name: "POST /api/support/platform",
    call: () =>
      platform.POST(
        request("POST", "/api/support/platform", {
          flowId: "PAYMENTS_BILLING",
          nodeId: null,
        }),
      ),
    matrix: {
      anonymous: 401,
      owner: "pass",
      orgManager: "pass",
      staff: "pass",
      admin: "pass",
      staffNo2fa: 428,
    },
  },
  {
    name: "POST /api/support/platform (orgId attribution)",
    call: () =>
      platform.POST(
        request("POST", "/api/support/platform", {
          flowId: "PAYMENTS_BILLING",
          nodeId: null,
          orgId: "org-1",
        }),
      ),
    matrix: { anonymous: 401, other: 403, orgManager: "pass", staff: 403 },
  },
  {
    name: "GET /api/support/requests",
    call: () => requests.GET(request("GET", "/api/support/requests")),
    matrix: {
      ...AUTHED,
      owner: "pass",
      other: "pass",
      orgManager: "pass",
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "GET /api/support/requests/[caseKey]",
    call: () =>
      ownRequest.GET(
        request("GET", "/api/support/requests/c_case-personal"),
        params({ caseKey: "c_case-personal" }),
      ),
    // The customer inbox reader: operators open cases through the workspace.
    matrix: {
      ...AUTHED,
      owner: "pass",
      expert: 404,
      other: 404,
      orgOwner: 404,
      staff: 404,
      admin: 404,
    },
  },
  {
    name: "POST /api/support/tickets",
    call: () =>
      tickets.POST(
        request("POST", "/api/support/tickets", {
          targetUserId: "u-owner",
          title: "We noticed a failed payment",
          description: "Please retry your payment.",
        }),
      ),
    matrix: {
      ...AUTHED,
      owner: 403,
      expert: 403,
      orgOwner: 403,
      staff: "pass",
      admin: "pass",
    },
  },
  {
    name: "POST /api/support/tickets (malformed body)",
    call: () =>
      tickets.POST(request("POST", "/api/support/tickets", { title: "x" })),
    // Authorization runs before the body is read.
    matrix: { ...AUTHED, owner: 403, staff: 400, admin: 400 },
  },
];

describe.each(HANDLERS)("$name", ({ call, matrix, setup }) => {
  it.each(rows(matrix))("%s → %s", async (persona, outcome) => {
    setup?.(persona);
    signIn(persona);
    expect(await outcomeOf(await call(), outcome)).toBe(String(outcome));
  });
});

describe("organization-owned cases", () => {
  const ORG_READERS: [string, (caseId: string) => Promise<Response>][] = [
    [
      "GET /api/support/cases/[caseId]",
      (caseId) =>
        caseDetail.GET(
          request("GET", `/api/support/cases/${caseId}`),
          caseParams(caseId),
        ),
    ],
    [
      "GET /api/support/cases/[caseId]/receipt",
      (caseId) =>
        caseReceipt.GET(
          request("GET", `/api/support/cases/${caseId}/receipt`),
          caseParams(caseId),
        ),
    ],
    [
      "GET /api/support/cases/[caseId]/messages",
      (caseId) =>
        caseMessages.GET(
          request("GET", `/api/support/cases/${caseId}/messages`),
          caseParams(caseId),
        ),
    ],
    [
      "POST /api/support/cases/[caseId]/messages",
      (caseId) =>
        caseMessages.POST(
          request("POST", `/api/support/cases/${caseId}/messages`, {
            body: "Following up",
          }),
          caseParams(caseId),
        ),
    ],
    [
      "GET /api/support/cases/[caseId]/actions",
      (caseId) =>
        caseActions.GET(
          request("GET", `/api/support/cases/${caseId}/actions`),
          caseParams(caseId),
        ),
    ],
    [
      "GET /api/support/cases/[caseId]/attachments",
      (caseId) =>
        caseAttachments.GET(
          request("GET", `/api/support/cases/${caseId}/attachments`),
          caseParams(caseId),
        ),
    ],
  ];
  const SCOPES: [string, Matrix][] = [
    [
      "case-org-ops",
      {
        orgOwner: "pass",
        orgManager: "pass",
        orgBilling: 404,
        orgLearner: 404,
        owner: 404,
        staff: "pass",
      },
    ],
    [
      "case-org-billing",
      {
        orgBilling: "pass",
        orgOwner: "pass",
        orgManager: 404,
        orgLearner: 404,
        owner: 404,
        staff: "pass",
      },
    ],
  ];
  describe.each(ORG_READERS)("%s", (_name, call) => {
    describe.each(SCOPES)("%s", (caseId, matrix) => {
      it.each(rows(matrix))("%s → %s", async (persona, outcome) => {
        signIn(persona);
        expect(await outcomeOf(await call(caseId), outcome)).toBe(
          String(outcome),
        );
      });
    });
  });
});

describe("POST /api/support/cases scope checks", () => {
  const ORG_OPS = {
    ...BASE_CASE_BODY,
    organizationId: "org-1",
    ownershipScope: "ORG_OPERATIONS",
  };
  const ORG_BILLING = { ...ORG_OPS, ownershipScope: "ORG_BILLING" };
  const SCENARIOS: [string, Persona, Outcome, Row][] = [
    ["org operations case by a MANAGER", "orgManager", "pass", ORG_OPS],
    ["org operations case by a LEARNER", "orgLearner", 403, ORG_OPS],
    ["org operations case by a non-member", "other", 403, ORG_OPS],
    ["org billing case by a BILLING_ADMIN", "orgBilling", "pass", ORG_BILLING],
    ["org billing case by a MANAGER", "orgManager", 403, ORG_BILLING],
    [
      "filing for another member as OWNER",
      "orgOwner",
      "pass",
      {
        ...BASE_CASE_BODY,
        organizationId: "org-1",
        requesterUserId: "u-org-learner",
      },
    ],
    [
      "filing for another member as MANAGER",
      "orgManager",
      403,
      {
        ...BASE_CASE_BODY,
        organizationId: "org-1",
        requesterUserId: "u-org-learner",
      },
    ],
    [
      "filing for another user without an organization",
      "other",
      403,
      { ...BASE_CASE_BODY, requesterUserId: "u-owner" },
    ],
    [
      "booking case by the payer",
      "owner",
      "pass",
      { ...BASE_CASE_BODY, appointmentId: "appt-1" },
    ],
    [
      "booking case by an unrelated user",
      "other",
      403,
      { ...BASE_CASE_BODY, appointmentId: "appt-1" },
    ],
    [
      "staff filing for a customer",
      "staff",
      "pass",
      { ...BASE_CASE_BODY, requesterUserId: "u-owner" },
    ],
  ];
  it.each(SCENARIOS)("%s (%s) → %s", async (_label, persona, outcome, body) => {
    signIn(persona);
    expect(
      await outcomeOf(
        await cases.POST(request("POST", "/api/support/cases", body)),
        outcome,
      ),
    ).toBe(String(outcome));
  });
});

describe("list visibility", () => {
  async function listedIds(res: Response): Promise<string[]> {
    const json: { data: { id: string }[] } = await res.json();
    return json.data.map((row) => row.id).sort();
  }

  it.each([
    ["owner", ["case-personal"]],
    ["other", []],
    ["orgManager", ["case-org-ops"]],
    ["orgBilling", ["case-org-billing"]],
    ["orgOwner", ["case-org-billing", "case-org-ops"]],
    ["staff", ["case-org-billing", "case-org-ops", "case-personal"]],
  ] as const)("GET /api/support/cases lists for %s", async (persona, ids) => {
    signIn(persona);
    expect(
      await listedIds(await cases.GET(request("GET", "/api/support/cases"))),
    ).toEqual([...ids]);
  });

  it.each([
    ["owner", ["case-personal"]],
    ["other", []],
    ["staff", []],
  ] as const)(
    "GET /api/support/requests lists only the caller's own inbox for %s",
    async (persona, ids) => {
      signIn(persona);
      expect(
        await listedIds(
          await requests.GET(request("GET", "/api/support/requests")),
        ),
      ).toEqual([...ids]);
    },
  );
});

describe("appointment support org-party intents", () => {
  it.each([
    ["CANCEL_REFUND", 403],
    ["SPONSORSHIP_BILLING", "pass"],
  ] as const)("an org operator raising %s → %s", async (category, outcome) => {
    signIn("orgManager");
    const res = await appointmentSupport.POST(
      request("POST", "/api/appointments/appt-1/support", { category }),
      params({ appointmentId: "appt-1" }),
    );
    expect(await outcomeOf(res, outcome)).toBe(String(outcome));
  });
});

describe("case actions money doors", () => {
  const HOLD = {
    action: "APPLY_HOLD",
    clientActionId: "ca-hold",
    expectedUpdatedAt: new Date().toISOString(),
    paymentId: "pay-1",
    reason: "Dispute under review",
  };

  it.each(["owner", "staff"] as const)(
    "delegates APPLY_HOLD to the audited door for %s",
    async (persona) => {
      signIn(persona);
      const res = await caseActions.POST(
        request("POST", "/api/support/cases/case-personal/actions", HOLD),
        caseParams(),
      );
      expect(res.status).toBe(200);
      expect(applySupportHoldDoor).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["anonymous", 401],
    ["staffNo2fa", 428],
  ] as const)("refuses %s before the door", async (persona, status) => {
    signIn(persona);
    const res = await caseActions.POST(
      request("POST", "/api/support/cases/case-personal/actions", HOLD),
      caseParams(),
    );
    expect(res.status).toBe(status);
    expect(applySupportHoldDoor).not.toHaveBeenCalled();
  });
});

describe("public external-verify link", () => {
  const LINK = `case=case-personal&issued=${Date.now()}&token=${"a".repeat(64)}`;

  function form(token: string): NextRequest {
    const body = new FormData();
    body.set("case", "case-personal");
    body.set("issued", String(Date.now()));
    body.set("token", token);
    return new NextRequest("https://app.test/api/support/external-verify", {
      method: "POST",
      body,
    });
  }

  it("renders the confirm form to an anonymous visitor", () => {
    const res = externalVerify.GET(
      request("GET", `/api/support/external-verify?${LINK}`),
    );
    expect(res.status).toBe(200);
  });

  it("answers a malformed link with the expired page", () => {
    const res = externalVerify.GET(
      request("GET", "/api/support/external-verify?case=x&issued=1&token=nope"),
    );
    expect(res.status).toBe(400);
  });

  it("confirms anonymously when the token verifies", async () => {
    const res = await externalVerify.POST(form("a".repeat(64)));
    expect(res.status).toBe(200);
    expect(confirmExternalRequesterEmail).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "case-personal" }),
    );
  });

  it("refuses a token the server rejects", async () => {
    jest.mocked(confirmExternalRequesterEmail).mockResolvedValueOnce("INVALID");
    const res = await externalVerify.POST(form("b".repeat(64)));
    expect(res.status).toBe(400);
  });
});
