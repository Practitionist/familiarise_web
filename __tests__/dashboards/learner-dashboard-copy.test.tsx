/**
 * Learner dashboard copy: each screen states its state in proper sentences
 * and only promises what the server does.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { UnpaidRequestedBookingControls } from "@/app/dashboard/consultee/[consulteeId]/(features)/appointments/[appointmentId]/DetailPageClient";

function withClient(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

describe("appointment detail: unpaid request banner", () => {
  it("reads as two sentences", () => {
    withClient(
      <UnpaidRequestedBookingControls appointmentId="appt-1" initialNotes="" />,
    );
    const banner = screen.getByTestId("unpaid-request-controls");
    expect(banner.textContent).toContain(
      "Unpaid booking request. You can edit your note before the expert responds.",
    );
  });
});
