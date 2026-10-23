import { render, screen } from "@testing-library/react";
import { ReconcileTab } from "../../components/dashboard/backoffice/money/ReconcileTab";
import type { ReconcileOverview } from "../../schemas/backoffice/reconciliation";

let overview: ReconcileOverview;
jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: overview, error: null }),
}));
jest.mock("../../components/dashboard/backoffice/money/ops-door", () => ({
  useOpsDoor: () => ({ isPending: false, mutate: jest.fn() }),
}));
jest.mock("../../components/dashboard/backoffice/money/ReasonDialog", () => ({
  ReasonDialog: () => null,
}));
jest.mock("../../components/dashboard/PageScaffold", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

beforeEach(() => {
  overview = {
    jobs: [
      {
        key: "ledgers",
        label: "Ledger reconciliation",
        description: "Advances one batch",
        last: null,
      },
    ],
    ledgerReport: {
      id: "report-1",
      runAt: "2026-10-23T00:00:00Z",
      ok: false,
      scope: "full",
      status: "RUNNING",
    },
  };
});
it("shows continuation for an unfinished report without calling it drift", () => {
  render(<ReconcileTab />);
  expect(
    screen.getByText(/in progress; continue the audit/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Continue audit" }),
  ).toBeInTheDocument();
  expect(screen.queryByText(/found drift/)).not.toBeInTheDocument();
});
it("distinguishes a failed attempt from a completed discrepant report", () => {
  if (!overview.ledgerReport) throw new Error("Missing fixture");
  overview.ledgerReport.status = "FAILED";
  render(<ReconcileTab />);
  expect(
    screen.getByText(/failed to finish; retry to continue/),
  ).toBeInTheDocument();
  expect(screen.queryByText(/found drift/)).not.toBeInTheDocument();
});
it("shows drift only for a completed report", () => {
  if (!overview.ledgerReport) throw new Error("Missing fixture");
  overview.ledgerReport.status = "COMPLETED";
  render(<ReconcileTab />);
  expect(screen.getByText(/found drift/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run now" })).toBeInTheDocument();
});
it("does not invent a verdict for an unclassified legacy report", () => {
  if (!overview.ledgerReport) throw new Error("Missing fixture");
  overview.ledgerReport.status = "UNKNOWN";
  render(<ReconcileTab />);
  expect(screen.getByText(/completion status unavailable/)).toBeInTheDocument();
  expect(screen.queryByText(/found drift/)).not.toBeInTheDocument();
});
