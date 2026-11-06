/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationPreferencesPanel } from "@/components/notifications/NotificationPreferencesPanel";
import { NotificationPreferenceSchema } from "@/schemas/user";
let mockUserId = "first";
const mockFetch = jest.fn();
const originalFetch = globalThis.fetch;
jest.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => true }));
jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: mockUserId } }, isPending: false }),
}));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
afterEach(() => (globalThis.fetch = originalFetch));
it("does not display an old account's late marketing-save response as the new account's consent", async () => {
  mockUserId = "first";
  globalThis.fetch = mockFetch;
  let resolveSave: (value: unknown) => void = () => {};
  const gate = new Promise((resolve) => (resolveSave = resolve));
  mockFetch.mockImplementation(async (url, options) =>
    options?.method === "PUT"
      ? gate
      : {
          ok: true,
          json: async () =>
            String(url).endsWith("/inbox")
              ? { globalMuted: false, workflows: [] }
              : NotificationPreferenceSchema.parse({}),
        },
  );
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <NotificationPreferencesPanel />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByLabelText("Products and offers"));
  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(([, options]) => options?.method === "PUT"),
    ).toBe(true),
  );
  mockUserId = "second";
  view.rerender(
    <QueryClientProvider client={client}>
      <NotificationPreferencesPanel />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Products and offers")).not.toBeChecked(),
  );
  resolveSave({
    ok: true,
    json: async () =>
      NotificationPreferenceSchema.parse({ marketingEmails: true }),
  });
  await waitFor(() =>
    expect(client.getQueryData(["notification-preferences", "first"])).toEqual(
      expect.objectContaining({ marketingEmails: true }),
    ),
  );
  expect(client.getQueryData(["notification-preferences", "second"])).toEqual(
    expect.objectContaining({ marketingEmails: false }),
  );
  expect(screen.getByLabelText("Products and offers")).not.toBeChecked();
});

it("closes an earlier account's inbox-adoption confirmation when account identity changes", async () => {
  mockUserId = "first";
  mockFetch.mockClear();
  globalThis.fetch = mockFetch;
  mockFetch.mockImplementation(async (url) => ({
    ok: true,
    json: async () =>
      String(url).endsWith("/inbox")
        ? { globalMuted: true, workflows: [] }
        : NotificationPreferenceSchema.parse({}),
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <NotificationPreferencesPanel />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Use the settings on this page",
    }),
  );
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  mockUserId = "second";
  view.rerender(
    <QueryClientProvider client={client}>
      <NotificationPreferencesPanel />
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "Use the settings on this page" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    mockFetch.mock.calls.some(([, options]) => options?.method === "POST"),
  ).toBe(false);
});
