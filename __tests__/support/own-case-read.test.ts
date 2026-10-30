/** @jest-environment node */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportCase: { findFirst: jest.fn() },
    supportCaseMessage: { findMany: jest.fn() },
  },
}));
jest.mock("../../lib/support/case-access", () => ({
  ...jest.requireActual("../../lib/support/case-access"),
  visibleCaseWhere: jest.fn(async () => ({ deletedAt: null })),
  canCorrespondOnCase: jest.fn(async () => true),
  isPresenterOnCase: jest.fn(async () => false),
}));
jest.mock("../../lib/support/case-workspace", () => ({
  TIMELINE_LIMIT: 200,
  readPayment: jest.fn(async () => null),
}));
import { readOwnSupportCase } from "../../lib/support/own-case-read";
import {
  canCorrespondOnCase,
  isPresenterOnCase,
} from "../../lib/support/case-access";
import { readPayment } from "../../lib/support/case-workspace";

const db = jest.requireMock<{
  default: {
    supportCase: { findFirst: jest.Mock };
    supportCaseMessage: { findMany: jest.Mock };
  };
}>("../../lib/prisma").default;
const cases = db.supportCase.findFirst;
const messages = db.supportCaseMessage.findMany;
const access = jest.mocked(canCorrespondOnCase);
const presenter = jest.mocked(isPresenterOnCase);
const payment = jest.mocked(readPayment);
const now = new Date("2026-10-19T10:00:00Z");
const fixture = {
  id: "case-1",
  title: "Payment help",
  referenceNumber: "FAM-2026-000001",
  category: "PAYMENT_STATUS",
  issueType: null,
  status: "RESOLVED",
  createdAt: now,
  resolvedAt: now,
  ackDueAt: now,
  csatRating: 4,
  appointmentId: null,
  ownershipScope: "PERSONAL",
  organizationId: null,
  organization: null,
  subjects: [],
  requesterUserId: "user-1",
  submitterUserId: "user-1",
};
beforeEach(() => {
  jest.clearAllMocks();
  access.mockResolvedValue(true);
  presenter.mockResolvedValue(false);
  messages.mockResolvedValue([]);
});

it("reads only canonical rows with a private-message exclusion and returns current rating", async () => {
  cases.mockResolvedValue(fixture);
  const view = await readOwnSupportCase("case-1", "user-1");
  expect(view).toMatchObject({
    key: "c_case-1",
    caseId: "case-1",
    resolvedAt: now.toISOString(),
    csatRating: 4,
    canReply: true,
    viewerIsPresenter: false,
  });
  expect(presenter).not.toHaveBeenCalled();
  expect(messages).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { caseId: "case-1", isInternal: false },
      take: -201,
      orderBy: { seq: "asc" },
    }),
  );
});

it("returns the most recent 200 messages and an older cursor", async () => {
  cases.mockResolvedValue(fixture);
  messages.mockResolvedValue(
    Array.from({ length: 201 }, (_, i) => ({
      id: `m${i}`,
      seq: i + 1,
      sender: "USER",
      body: "body",
      createdAt: now,
      authorUser: null,
    })),
  );
  const view = await readOwnSupportCase("case-1", "user-1");
  expect(view?.timeline).toHaveLength(200);
  expect(view?.timeline[0].seq).toBe(2);
  expect(view?.hasMore).toBe(true);
  expect(view?.nextBeforeSeq).toBe(2);
});

it("returns a summary without fetching transcript for the subject of a personal org-filed case", async () => {
  access.mockResolvedValue(false);
  cases.mockResolvedValue({ ...fixture, submitterUserId: "org-operator" });
  const view = await readOwnSupportCase("case-1", "user-1");
  expect(view).toMatchObject({
    subject: "Organization support request",
    timeline: [],
    payment: null,
    csatRating: null,
    filedByOrganizationNotice: true,
    canReply: false,
  });
  expect(messages).not.toHaveBeenCalled();
});

it("retains the transcript for an authorized organization successor", async () => {
  cases.mockResolvedValue({
    ...fixture,
    ownershipScope: "ORG_OPERATIONS",
    submitterUserId: "old-operator",
  });
  await readOwnSupportCase("case-1", "successor");
  expect(messages).toHaveBeenCalled();
});

it("gives an accepted presenter the public thread without payment, CSAT or reopen", async () => {
  access.mockResolvedValue(false);
  presenter.mockResolvedValue(true);
  cases.mockResolvedValue({ ...fixture, appointmentId: "appt-1" });
  messages.mockResolvedValue([
    {
      id: "m1",
      seq: 1,
      sender: "USER",
      body: "hello",
      createdAt: now,
      metadata: null,
      authorUser: null,
    },
    {
      id: "m2",
      seq: 2,
      sender: "AGENT",
      body: "Presenter here",
      createdAt: now,
      metadata: { actorKind: "PRESENTER" },
      authorUser: { name: "Dr Rao" },
    },
  ]);
  const view = await readOwnSupportCase("case-1", "presenter");
  expect(view).toMatchObject({
    canReply: true,
    viewerIsPresenter: true,
    payment: null,
    csatRating: null,
    filedByOrganizationNotice: false,
  });
  expect(view?.timeline).toHaveLength(2);
  expect(view?.timeline[1]).toMatchObject({
    author: "AGENT",
    authorName: "Dr Rao",
    actorKind: "PRESENTER",
  });
  expect(view?.timeline[0].actorKind).toBeUndefined();
  expect(payment).not.toHaveBeenCalled();
});
