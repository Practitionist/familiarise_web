/**
 * Staff support wording: an outbound request that joins an open case says so,
 * countdowns read in days from 48 hours, and a passed resolution date reads overdue.
 */

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockToast = jest.fn();
const mockPush = jest.fn();
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));
jest.mock(
  "../../components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({ basePath: "/dashboard/staff" }),
  }),
);
jest.mock(
  "../../components/dashboard/backoffice/support/UserSearchCombobox",
  () => ({
    UserSearchCombobox: ({
      onChange,
    }: {
      onChange: (u: { id: string; name: string; email: string }) => void;
    }) => (
      <button
        type="button"
        onClick={() =>
          onChange({ id: "u_1", name: "Patrick", email: "p@example.com" })
        }
      >
        Pick customer
      </button>
    ),
  }),
);

const mockCase: Record<string, unknown> = {};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportCase: {
      findFirst: jest.fn(async () => mockCase),
      findMany: jest.fn(async () => []),
    },
  },
}));
jest.mock("../../lib/observability/sentry-issues", () => ({
  findUserIssues: async () => [],
}));

import { readCaseWorkspace } from "../../lib/support/case-workspace";
import { StaffSupportComposeDialog } from "../../components/dashboard/backoffice/support/StaffSupportComposeDialog";
import { resolutionDeadline, slaHint } from "../../lib/support/sla-hint";
import { slaStateOf, type SlaClock } from "../../lib/support/sla";

const HOUR = 3_600_000;
const NOW = new Date("2026-11-12T12:52:00.000Z");
const clock = (patch: Partial<SlaClock>): SlaClock => ({
  status: "IN_PROGRESS",
  ackDueAt: null,
  acknowledgedAt: new Date(NOW.getTime() - HOUR),
  resolutionDueAt: null,
  resolvedAt: null,
  awaitingUserSince: null,
  pausedSeconds: 0,
  statutoryDueAt: null,
  reopenedAt: null,
  ...patch,
});
const dueIn = (ms: number) =>
  slaStateOf(clock({ resolutionDueAt: new Date(NOW.getTime() + ms) }), NOW);

describe("support countdowns", () => {
  it("reads hours under two days and days with hours from 48 hours up", () => {
    expect(slaHint(dueIn(47 * HOUR))?.label).toBe("Due in 47h");
    expect(slaHint(dueIn(48 * HOUR))?.label).toBe("Due in 2d");
    expect(slaHint(dueIn(50 * HOUR))?.label).toBe("Due in 2d 2h");
    expect(slaHint(dueIn(168 * HOUR))?.label).toBe("Due in 7d");
  });

  it("says a passed resolution date is overdue, in a critical tone", () => {
    expect(resolutionDeadline(dueIn(5 * HOUR))).toEqual({
      prefix: "Resolve by",
      tone: "neutral",
    });
    expect(resolutionDeadline(dueIn(-2 * HOUR))).toEqual({
      prefix: "Resolution overdue since",
      tone: "critical",
    });
    const resolved = slaStateOf(
      clock({
        status: "RESOLVED",
        resolvedAt: NOW,
        resolutionDueAt: new Date(NOW.getTime() - HOUR),
      }),
      NOW,
    );
    expect(resolutionDeadline(resolved)).toBeNull();
  });
});

describe("case workspace deadline", () => {
  it("serves the resolution deadline the SLA is judged against, pauses included", async () => {
    // Due 2 hours ago as stored, but the case waited 5 hours on the customer.
    Object.assign(mockCase, {
      id: "case-9",
      title: "Refund",
      referenceNumber: "FAM-2026-000009",
      category: "REFUND_REQUEST",
      issueType: null,
      status: "IN_PROGRESS",
      priority: "MEDIUM",
      activeChannel: "HUMAN",
      assignedTo: null,
      ackDueAt: null,
      acknowledgedAt: new Date(Date.now() - 10 * HOUR),
      resolutionDueAt: new Date(Date.now() - 2 * HOUR),
      resolvedAt: null,
      awaitingUserSince: null,
      pausedSeconds: 5 * 3600,
      statutoryDueAt: null,
      reopenedAt: null,
      lastMessageAt: null,
      createdAt: new Date(Date.now() - 48 * HOUR),
      updatedAt: new Date(),
      description: "",
      appointmentId: null,
      requesterUserId: "u_1",
      externalRequesterEmail: null,
      externalRequesterName: null,
      callbackPhone: null,
      requester: {
        id: "u_1",
        name: "Patrick",
        email: "p@example.com",
        phone: null,
        role: "CONSULTEE",
        createdAt: new Date(),
      },
      organization: null,
      subjects: [],
      messages: [],
      events: [],
    });
    const ws = await readCaseWorkspace(
      { kind: "case", id: "case-9" },
      { showContact: false, showPayment: false },
    );
    const stored = Date.parse(ws!.resolutionDueAt!);
    expect(Date.parse(ws!.effectiveResolutionDueAt!) - stored).toBe(5 * HOUR);
    expect(resolutionDeadline(ws!.sla)?.prefix).toBe("Resolve by");
  });
});

describe("StaffSupportComposeDialog", () => {
  beforeAll(() => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    mockToast.mockClear();
  });

  async function submitWith(body: unknown, status: number) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status,
      json: async () => body,
    });
    const onOpenChange = jest.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StaffSupportComposeDialog open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pick customer" }));
    fireEvent.change(screen.getByLabelText("Subject *"), {
      target: { value: "Your GST invoice" },
    });
    fireEvent.change(screen.getByLabelText("Message *"), {
      target: { value: "We corrected the GSTIN on it." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create request/ }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  }

  it("names the open case a request was added to, with a link", async () => {
    await submitWith(
      {
        data: { id: "case-7", referenceNumber: "FAM-2026-000007" },
        reused: true,
        dedupeReason: "open_scope",
      },
      200,
    );
    expect(mockToast).toHaveBeenCalledTimes(1);
    const notice = mockToast.mock.calls[0][0];
    expect(notice.title).toBe(
      "Added to FAM-2026-000007 because this customer already has an open case",
    );
    expect(notice.action.props.children).toBe("Open case");
    notice.action.props.onClick();
    expect(mockPush).toHaveBeenCalledWith("/dashboard/staff/support/c_case-7");
  });

  it("stays quiet for a new case", async () => {
    await submitWith(
      {
        data: { id: "case-8", referenceNumber: "FAM-2026-000008" },
        reused: false,
        dedupeReason: null,
      },
      201,
    );
    expect(mockToast).not.toHaveBeenCalled();
  });
});
