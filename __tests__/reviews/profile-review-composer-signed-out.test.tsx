/**
 * The ISR expert profile never asks for review eligibility on a visitor's
 * behalf: signed out, or while the session is loading, no request is sent.
 */
import * as React from "react";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockUseSession = jest.fn();
jest.mock("@/lib/auth-client", () => ({
  useSession: () => mockUseSession(),
}));
jest.mock("@/components/reviews/ReviewComposer", () => ({
  ReviewComposer: ({ contextLine }: { contextLine: string }) => (
    <p>{contextLine}</p>
  ),
}));

import { ProfileReviewComposer } from "@/components/reviews/ProfileReviewComposer";

function renderComposer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProfileReviewComposer
        consultantProfileId="cp-1"
        consultantName="Hannah"
      />
    </QueryClientProvider>,
  );
}

describe("ProfileReviewComposer session gate", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it.each([
    ["signed out", { data: null, isPending: false }],
    ["session loading", { data: null, isPending: true }],
  ])("sends no eligibility request when %s", async (_label, session) => {
    mockUseSession.mockReturnValue(session);
    const { container } = renderComposer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("asks once signed in and renders the parsed session", async () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: "user-1" } },
      isPending: false,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            appointmentId: "appt-1",
            consultantName: "Hannah",
            title: "Career consultation",
            heldAt: "2026-11-02T04:30:00.000Z",
            profileIsPublic: true,
            existingReview: null,
          },
        ],
      }),
    });
    const { findByText } = renderComposer();
    expect(await findByText("Career consultation")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toContain("consultantProfileId=cp-1");
  });
});
