/**
 * The class session doors are called with the caller's identity header, so the
 * server's `expectUser` check sees who is acting.
 */
import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockFetchWithIdentity = jest.fn(
  async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({}), { status: 200 }),
);
jest.mock("../../lib/auth/identity-header", () => ({
  fetchWithIdentity: (url: string, init?: RequestInit) =>
    mockFetchWithIdentity(url, init),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { ClassSessionControls } from "../../components/appointments/detail/ClassSessionControls";

it("cancels a class session through the identity-carrying fetch", async () => {
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ClassSessionControls
        appointmentId="apt-1"
        role="consultant"
        unitLabel={null}
        onChanged={jest.fn()}
        sessions={[
          {
            id: "occ-1",
            ordinal: 1,
            startsAt,
            completionStatus: "SCHEDULED",
          },
        ]}
      />
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Cancel this session" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel this session" }),
  );

  await waitFor(() =>
    expect(mockFetchWithIdentity).toHaveBeenCalledWith(
      "/api/appointments/apt-1/occurrences/occ-1/cancel",
      expect.objectContaining({ method: "POST" }),
    ),
  );
});
