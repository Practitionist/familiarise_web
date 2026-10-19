/**
 * @jest-environment jsdom
 */

/**
 * On a closed case the staff composer refuses public replies up front, with a
 * note saying why, and keeps private notes available.
 *
 * The canonical model is ONE `SupportCase`: the workspace carries `caseId`
 * (never a legacy ticket id) and the composer reads the case's own status from
 * there, so the lock follows the case rather than a second table.
 */

jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  CaseConversation,
  type ComposerMode,
} from "../../components/dashboard/backoffice/support/CaseConversation";
import type { CaseWorkspace } from "../../types/support-case";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout engine, so the pane's scroll-to-the-end would throw.
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const CASE_ID = "case_1";

/** The canonical workspace `readCaseWorkspace` hands the staff pane. */
function workspace(status: string): CaseWorkspace {
  return {
    key: `c_${CASE_ID}`,
    kind: "case",
    caseId: CASE_ID,
    subject: "Refund not received",
    reference: "FAM-2026-000001",
    topic: "payments",
    status,
    priority: "MEDIUM",
    channel: "HUMAN",
    assignee: { id: "staff_1", name: "Asha" },
    sla: null,
    ackDueAt: null,
    resolutionDueAt: null,
    lastMessageAt: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    handoffSummary: null,
    botPromises: [],
    duplicateOpenCases: [],
    events: [],
    person: {
      id: "user_1",
      name: "Ravi",
      role: "CONSULTEE",
      email: "ravi@example.com",
      phone: null,
      joinedAt: "2026-01-04T09:00:00.000Z",
    },
    booking: null,
    payment: null,
    organization: null,
    pastCases: [],
    timeline: [],
    hasMore: false,
    nextBeforeSeq: null,
    attachments: [],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // The pane lists the case's attachments; the list is empty here.
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: [] }),
  }) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (global as { fetch?: unknown }).fetch;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(status: string, mode: ComposerMode): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CaseConversation
          data={workspace(status)}
          mode={mode}
          onModeChange={jest.fn()}
          replyDraft="Thanks for waiting"
          onReplyDraftChange={jest.fn()}
          sending={false}
          onSend={jest.fn()}
          replies={[]}
          suggested={[]}
          helpArticles={[]}
          onInsert={jest.fn()}
        />
      </QueryClientProvider>,
    );
  });
  await flush();
}

function composer(): HTMLTextAreaElement {
  const el = container.querySelector("textarea");
  if (!el) throw new Error("The composer has no textarea");
  return el;
}

function buttonLabelled(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`No "${label}" button`);
  return el;
}

describe("CaseConversation on a closed case", () => {
  it("disables the public reply and says private notes still work", async () => {
    await render("CLOSED", "reply");
    expect(container.textContent).toContain(
      "the customer can't receive replies",
    );
    expect(composer()).toBeDisabled();
    expect(buttonLabelled("Send reply")).toBeDisabled();
  });

  it("leaves the private note composer usable", async () => {
    await render("CLOSED", "note");
    expect(container.textContent).not.toContain("can't receive replies");
    expect(composer()).not.toBeDisabled();
    // A canonical case always carries an id, so the legacy "needs a ticket"
    // gate never fires.
    expect(container.textContent).not.toContain("Needs a ticket");
  });

  it("leaves an open case untouched", async () => {
    await render("OPEN", "reply");
    expect(composer()).not.toBeDisabled();
    expect(buttonLabelled("Send reply")).not.toBeDisabled();
  });
});
