import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { AnnouncementsPage } from "@/components/dashboard/shared/AnnouncementsPage";

/**
 * An inbox post spends one Novu run per recipient, so the create dialog shows
 * the eligible count and keeps Create disabled until the admin confirms it.
 */

// Radix Checkbox measures itself with this; jsdom has none.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function mockFetch(audience: { eligible: number | null; cap: number }) {
  globalThis.fetch = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.endsWith("/audience")
        ? { success: true, data: audience }
        : { success: true, data: [] },
  })) as unknown as typeof fetch;
}

async function openCreateAndTickInbox() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AnnouncementsPage />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /new announcement/i }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /inbox/i }));
}

it("asks the admin to confirm the eligible count before an inbox post", async () => {
  mockFetch({ eligible: 1234, cap: 2000 });
  await openCreateAndTickInbox();

  const confirm = await screen.findByRole("checkbox", {
    name: /post to 1,234 eligible users/i,
  });
  expect(screen.getByText(/one Novu workflow run/i)).toBeInTheDocument();
  const create = screen.getByRole("button", { name: /^create$/i });
  expect(create).toBeDisabled();

  fireEvent.click(confirm);
  await waitFor(() => expect(create).toBeEnabled());
  expect(globalThis.fetch).toHaveBeenCalledWith("/api/announcements/audience");
});

it("refuses an inbox post over the audience cap", async () => {
  mockFetch({ eligible: null, cap: 2000 });
  await openCreateAndTickInbox();

  expect(await screen.findByText(/over the inbox limit/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^create$/i })).toBeDisabled();
});

it("never offers an earlier count for confirmation while it is recounted", async () => {
  mockFetch({ eligible: 5, cap: 2000 });
  await openCreateAndTickInbox();
  await screen.findByRole("checkbox", { name: /post to 5 eligible users/i });

  let finishRecount: (value: unknown) => void = () => {};
  globalThis.fetch = jest.fn(
    () =>
      new Promise((resolve) => {
        finishRecount = resolve;
      }),
  ) as unknown as typeof fetch;
  const inbox = screen.getByRole("checkbox", { name: /inbox/i });
  fireEvent.click(inbox);
  fireEvent.click(inbox);

  expect(screen.getByText(/counting eligible users/i)).toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: /post to 5 eligible/i }),
  ).not.toBeInTheDocument();

  finishRecount({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { eligible: 9, cap: 2000 } }),
  });
  expect(
    await screen.findByRole("checkbox", { name: /post to 9 eligible users/i }),
  ).toBeInTheDocument();
});
