/**
 * Approving requested times from the inbox: a refusal that leaves the request
 * allocatable (a time taken, a busy lock, a co-host clash) keeps the dialog
 * open with the server's sentence and re-checks the times; a request that
 * moved on (allocated elsewhere, no longer pending) closes and refreshes.
 */

// The inbox reaches payout setup, whose clawback notices load the email stack (unloadable in jsdom).
jest.mock("@/lib/payments/payouts/clawback-notifications", () =>
  jest
    .requireActual("../fixtures/requests-inbox-mocks")
    .clawbackNoticesModule(),
);
jest.mock("../../lib/prisma", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").inboxPrismaModule(),
);
jest.mock("next/navigation", () =>
  jest
    .requireActual("../fixtures/requests-inbox-mocks")
    .inboxNavigationModule(),
);
jest.mock("../../lib/scheduling/allocationService", () => ({
  AllocationService: { validateSlots: jest.fn(), allocateSlots: jest.fn() },
}));
jest.mock("../../lib/auth-client", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").signedOutAuthModule(),
);
jest.mock("../../lib/time/use-viewer-zone", () =>
  jest
    .requireActual("../fixtures/requests-inbox-mocks")
    .kolkataViewerZoneModule(),
);
jest.mock("../../components/ui/use-toast", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").toastModule(),
);

import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { type RequestsInboxPayload } from "@/lib/dashboard/requests-inbox-state";
import { AllocationService } from "@/lib/scheduling/allocationService";
import { toast } from "@/components/ui/use-toast";
import { classifyProposalConflict } from "@/components/dashboard/shared/requests/request-decision";
import { NOW } from "../fixtures/requests-inbox";
import {
  mountInbox,
  readInboxPayload,
  stubDesktopMatchMedia,
} from "../fixtures/requests-inbox-render";

const validateSlots = AllocationService.validateSlots as jest.Mock;
const allocateSlots = AllocationService.allocateSlots as jest.Mock;

let payload: RequestsInboxPayload;

beforeAll(async () => {
  stubDesktopMatchMedia();
  payload = await readInboxPayload();
});

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, advanceTimers: true });
  jest.clearAllMocks();
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
  validateSlots.mockImplementation(async (_type, _id, slots: unknown[]) => ({
    success: true,
    data: {
      conflicts: [],
      outsideAvailability: [],
      validSlots: slots,
    },
  }));
});

afterEach(() => {
  jest.useRealTimers();
});

function mount() {
  mountInbox(payload);
}

async function openAndConfirm() {
  fireEvent.click(screen.getByRole("button", { name: /^Approve/ }));
  const confirm = await screen.findByRole("button", {
    name: "Allocate requested times",
  });
  await waitFor(() => expect(confirm).toBeEnabled());
  await act(async () => {
    fireEvent.click(confirm);
  });
}

const dialogOpen = () =>
  screen.queryByRole("heading", { name: "Confirm requested times" }) !== null;

describe("requested-times approval conflicts", () => {
  it.each([
    ["LOCK_BUSY", "Someone else is booking these times right now. Try again."],
    ["TIMES_TAKEN", "One of these times was just booked. Pick another time."],
    ["COHOST_CONFLICT", "A co-host is busy at one of these times."],
    ["SOMETHING_NEW", "Those times could not be booked just now."],
  ])(
    "%s keeps the dialog open with the server's sentence and re-checks the times",
    async (errorCode, error) => {
      allocateSlots.mockResolvedValue({
        success: false,
        httpStatus: 409,
        errorCode,
        error,
      });
      mount();
      await openAndConfirm();

      const alert = await screen.findByText(error);
      expect(alert).toHaveAttribute("role", "alert");
      expect(dialogOpen()).toBe(true);
      await waitFor(() =>
        expect(validateSlots.mock.calls.length).toBeGreaterThanOrEqual(2),
      );
      // The consultant can try again in place.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Allocate requested times" }),
        ).toBeEnabled(),
      );
      expect(toast).not.toHaveBeenCalled();
    },
  );

  it.each(["ALREADY_ALLOCATED", "ILLEGAL_TRANSITION", "NOT_PENDING"])(
    "%s closes the dialog and refreshes the list",
    async (errorCode) => {
      allocateSlots.mockResolvedValue({
        success: false,
        httpStatus: 409,
        errorCode,
        error: "changed",
      });
      mount();
      await openAndConfirm();

      await waitFor(() => expect(dialogOpen()).toBe(false));
      expect(toast).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/bookings/inbox?"),
      );
    },
  );

  it("a retry after a refusal books with a fresh attempt key", async () => {
    allocateSlots
      .mockResolvedValueOnce({
        success: false,
        httpStatus: 409,
        errorCode: "LOCK_BUSY",
        error: "Busy, try again.",
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: "appt-1" }],
        awaitingPayment: false,
      });
    mount();
    await openAndConfirm();
    await screen.findByText("Busy, try again.");
    const again = screen.getByRole("button", {
      name: "Allocate requested times",
    });
    await waitFor(() => expect(again).toBeEnabled());
    await act(async () => {
      fireEvent.click(again);
    });
    await screen.findByText("Times confirmed");
    const [first, second] = allocateSlots.mock.calls.map(
      ([, , , opts]) => opts.idempotencyKey,
    );
    expect(second).not.toBe(first);
    expect(within(document.body).queryByText("Busy, try again.")).toBeNull();
  });
});

describe("proposal-answer conflicts", () => {
  it("keeps an allocator refusal of the proposed times open", () => {
    for (const code of ["TIMES_TAKEN", "LOCK_BUSY", "COHOST_CONFLICT"]) {
      expect(classifyProposalConflict(409, code)).toBe("stay-open");
    }
  });

  it("treats a proposal that is gone, closed or frozen as stale", () => {
    for (const code of [
      "PROPOSAL_NOT_FOUND",
      "PROPOSAL_NOT_OPEN",
      "PROPOSAL_EXPIRED",
      "RESCHEDULE_NO_LONGER_OPEN",
      "DISPUTE_ACTIVE",
      "ALREADY_ALLOCATED",
      "ILLEGAL_TRANSITION",
    ]) {
      expect(classifyProposalConflict(409, code)).toBe("stale");
    }
    expect(classifyProposalConflict(404, undefined)).toBe("stale");
    expect(classifyProposalConflict(423, "APPOINTMENT_BUSY")).toBeNull();
  });
});
