/**
 * The two rating asks on a booking page say which is which: the per-session
 * stars carry a visible "not public" caption at the 24 px target size, the
 * public review's heading carries a Public badge, and a saved review's button
 * stays disabled until something differs from what is saved.
 */

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/hooks/useSessionFeedback", () => ({
  bookingFeedbackKey: (id: string) => ["feedback", id],
  useSessionFeedback: () => ({
    comments: {},
    ratingCauses: {},
    supportOpen: false,
  }),
}));

import { ReviewComposer } from "@/components/reviews/ReviewComposer";
import { SessionRatingRow } from "@/components/reviews/SessionRatingRow";

const wrap = (node: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      {node}
    </QueryClientProvider>,
  );

describe("the per-session stars", () => {
  it("say in view who sees them, and are 24 px targets", () => {
    wrap(
      <SessionRatingRow
        appointmentId="a1"
        bookingAppointmentId="b1"
        occurrenceId="o1"
        existingRating={null}
      />,
    );
    expect(
      screen.getByText("Not public; shared with the expert"),
    ).toBeInTheDocument();
    const star = screen.getAllByRole("button", { name: /^Rate 1 out of 5/ })[0];
    expect(star.className).toContain("p-0.5");
    expect(star.querySelector("svg")?.getAttribute("class")).toContain(
      "h-5 w-5",
    );
  });
});

describe("the public review form", () => {
  const saved = {
    id: "rev_1",
    rating: 4,
    reviewDescription: "Useful session",
    isAnonymous: false,
    ratingCause: null,
  };
  const composer = (existing: typeof saved | null) =>
    wrap(<ComposerHarness existing={existing} />);

  it("badges its heading Public", () => {
    composer(null);
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Write a review of Michael Anderson",
      }),
    ).toBeInTheDocument();
  });

  it("keeps Update review off, and says Saved, until the review differs", () => {
    composer(saved);
    const update = screen.getByRole("button", { name: "Update review" });
    expect(update).toBeDisabled();
    expect(screen.getByText("Saved")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    expect(update).toBeEnabled();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "4 stars" }));
    expect(update).toBeDisabled();
  });

  it("lets a first review post as soon as it has a rating", () => {
    composer(null);
    const post = screen.getByRole("button", { name: "Post review" });
    expect(post).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    expect(post).toBeEnabled();
  });
});

function ComposerHarness({
  existing,
}: Readonly<{
  existing: React.ComponentProps<typeof ReviewComposer>["existing"];
}>) {
  return (
    <ReviewComposer
      appointmentId="appt_1"
      consultantName="Michael Anderson"
      existing={existing}
      profileIsPublic
      invalidateKeys={[]}
    />
  );
}
