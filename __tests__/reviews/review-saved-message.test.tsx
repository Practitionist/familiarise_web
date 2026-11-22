/**
 * The form's line and the message after posting name the expert's profile as
 * where the review appears only when that profile is public.
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
  "profileIsPublic=%s: the form and the saved message say where the review shows",
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
          profileIsPublic={profileIsPublic}
          invalidateKeys={[]}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByText(
        profileIsPublic
          ? /It appears on their profile with the date\./
          : /It will appear on their profile once it is live\./,
      ),
    ).toBeInTheDocument();
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
