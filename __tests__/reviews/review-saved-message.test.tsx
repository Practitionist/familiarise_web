/**
 * The message after posting a review names the expert's profile as where it
 * appears only when that profile is public; the review route says which.
 */

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockToast = jest.fn();
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { ReviewComposer } from "@/components/reviews/ReviewComposer";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

it.each([
  [true, "It appears on Michael Anderson's profile."],
  [
    false,
    "Saved. It will appear on Michael Anderson's public profile once that profile is live.",
  ],
])(
  "profileIsPublic=%s tells the learner where the review shows",
  async (profileIsPublic, description) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "rev_1", rating: 5, profileIsPublic }),
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ReviewComposer
          appointmentId="appt_held"
          consultantName="Michael Anderson"
          existing={null}
          invalidateKeys={[]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.click(screen.getByRole("button", { name: "Post review" }));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: "Thanks for your review",
        description,
      }),
    );
  },
);
