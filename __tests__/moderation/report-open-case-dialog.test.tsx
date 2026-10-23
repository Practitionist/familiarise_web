import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The limits module pulls next/server, which has no Request global under jsdom.
jest.mock("../../lib/validation/limits", () => ({
  MAX_TEXT_LENGTH: 5000,
  MAX_TITLE_LENGTH: 200,
}));
jest.mock("../../hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));
const mockToast = jest.fn();
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import {
  OpenReportCaseDialog,
  ReportCaseLink,
} from "../../components/dashboard/shared/ReportSupportCase";

const OPTIONS = {
  linkedCase: null,
  candidates: [
    {
      id: "appt-1",
      type: "CONSULTATION",
      title: "Career chat",
      startsAt: "2026-10-01T10:00:00.000Z",
      chatMatchesReport: true,
    },
    {
      id: "appt-2",
      type: "CONSULTATION",
      title: "Other chat",
      startsAt: null,
      chatMatchesReport: false,
    },
  ],
};

const json = (body: unknown, status = 200) =>
  Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as Response);

function renderDialog(onOpenChange = jest.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <OpenReportCaseDialog
        reportId="r1"
        basePath="/dashboard/staff"
        open
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  mockToast.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

it("links a linked case to the case workspace", () => {
  render(
    <ReportCaseLink
      basePath="/dashboard/admin"
      supportCase={{ id: "case-1", referenceNumber: "FAM-2026-000042" }}
    />,
  );
  expect(
    screen.getByRole("link", { name: /Case FAM-2026-000042/ }),
  ).toHaveAttribute("href", "/dashboard/admin/support/c_case-1");
});

it("opens a case once a booking, a category and a reason are chosen", async () => {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? json(
          { case: { id: "case-1", referenceNumber: "FAM-2026-000042" } },
          201,
        )
      : json(OPTIONS),
  );
  const onOpenChange = renderDialog();

  await screen.findByText("Career chat");
  expect(screen.getByRole("radio", { name: /Other chat/ })).toBeDisabled();

  const submit = screen.getByRole("button", { name: "Open case" });
  fireEvent.click(screen.getByRole("radio", { name: /Career chat/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Safety concern" }));
  fireEvent.change(screen.getByLabelText(/Reason/), {
    target: { value: "ok" },
  });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/Reason/), {
    target: { value: "reporter feels unsafe" },
  });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);

  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  const post = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );
  expect(post?.[0]).toBe("/api/staff/moderation/reports/r1/case");
  expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
    appointmentId: "appt-1",
    category: "SAFETY_CONCERN",
    reason: "reporter feels unsafe",
  });
  expect(mockToast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Support case opened" }),
  );
});

it("shows the existing case when the door refuses a second one", async () => {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? json(
          {
            code: "REPORT_HAS_CASE",
            error: "This report already has support case FAM-2026-000007.",
            existingCase: { id: "case-0", referenceNumber: "FAM-2026-000007" },
          },
          409,
        )
      : json(OPTIONS),
  );
  renderDialog();

  await screen.findByText("Career chat");
  fireEvent.click(screen.getByRole("radio", { name: /Career chat/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Other" }));
  fireEvent.change(screen.getByLabelText(/Reason/), {
    target: { value: "needs follow-up" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open case" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "already has support case FAM-2026-000007",
  );
  expect(
    screen.getByRole("link", { name: /Case FAM-2026-000007/ }),
  ).toHaveAttribute("href", "/dashboard/staff/support/c_case-0");
});

it("says so when the two users share no booking", async () => {
  fetchMock.mockImplementation(() =>
    json({ linkedCase: null, candidates: [] }),
  );
  renderDialog();
  expect(await screen.findByText(/share no booking/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open case" })).toBeDisabled();
});
