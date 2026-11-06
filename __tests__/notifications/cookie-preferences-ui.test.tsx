/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCookiePreferences } from "@/hooks/useCookiePreferences";
import CookieConsentBanner from "@/components/CookieConsent";
import { CookiePreferencesSection } from "@/components/dashboard/account/PrivacySection";
let mockIdentityPending = false;
let mockUserId = "user";
const mockFetch = jest.fn();
const originalFetch = globalThis.fetch;
const originalResizeObserver = globalThis.ResizeObserver;
jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: mockUserId } },
    isPending: mockIdentityPending,
  }),
}));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/auth/sign-out", () => ({ signOutEverywhere: jest.fn() }));
jest.mock("@/lib/auth/reauth-client", () => ({ fetchWithReauth: jest.fn() }));
beforeEach(() => {
  mockIdentityPending = false;
  mockUserId = "user";
  document.cookie = "cookie_consent=; max-age=0; path=/";
  globalThis.fetch = mockFetch;
  mockFetch.mockReset();
  globalThis.ResizeObserver = class {
    observe = jest.fn();
    disconnect = jest.fn();
    unobserve = jest.fn();
  };
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ essential: true, analytics: false, marketing: false }),
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = originalResizeObserver;
});
function show(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
}
it("keeps the banner visible and writes no acknowledgement when a save fails", async () => {
  show(<CookieConsentBanner />);
  mockFetch.mockImplementation(async (_url, options) =>
    options?.method === "PUT"
      ? { ok: false }
      : {
          ok: true,
          json: async () => ({
            essential: true,
            analytics: false,
            marketing: false,
          }),
        },
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Allow optional cookies" }),
  );
  await screen.findByRole("alert");
  expect(
    screen.getByRole("region", { name: "Cookie preferences" }),
  ).toBeInTheDocument();
  expect(document.cookie).not.toContain("cookie_consent=");
});
it("updates the shared Privacy controls and acknowledges only after successful persistence", async () => {
  show(
    <>
      <CookieConsentBanner />
      <CookiePreferencesSection />
    </>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Analytics cookies")).toBeEnabled(),
  );
  mockFetch.mockImplementation(async (_url, options) => ({
    ok: true,
    json: async () =>
      options?.method === "PUT"
        ? { essential: true, analytics: true, marketing: true }
        : { essential: true, analytics: false, marketing: false },
  }));
  fireEvent.click(
    screen.getByRole("button", { name: "Allow optional cookies" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Cookie preferences" }),
    ).not.toBeInTheDocument(),
  );
  expect(document.cookie).toContain("cookie_consent=true");
  expect(screen.getByLabelText("Analytics cookies")).toBeChecked();
  expect(screen.getByLabelText("Marketing cookies")).toBeChecked();
  expect(mockFetch).toHaveBeenCalledWith(
    "/api/cookie-preferences",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ analytics: true, marketing: true }),
    }),
  );
});
it("does not show editable default-off choices when the saved state cannot be loaded", async () => {
  mockFetch.mockResolvedValue({ ok: false });
  show(<CookiePreferencesSection />);
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Analytics cookies")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

it("does not read or save consent under an anonymous cache key while account identity is still loading", async () => {
  mockIdentityPending = true;
  show(<CookieConsentBanner />);
  expect(
    await screen.findByRole("button", { name: "Allow optional cookies" }),
  ).toBeDisabled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("does not cache a late save response under a newly signed-in account", async () => {
  let resolveSave: (value: unknown) => void = () => {};
  const gate = new Promise((resolve) => {
    resolveSave = resolve;
  });
  mockFetch.mockImplementation(async (_url, options) =>
    options?.method === "PUT"
      ? gate
      : {
          ok: true,
          json: async () => ({
            essential: true,
            analytics: false,
            marketing: false,
          }),
        },
  );
  function Probe() {
    const { query, mutation, identity } = useCookiePreferences();
    return (
      <>
        <p>
          {identity}:{String(query.data?.analytics)}
        </p>
        <button onClick={() => void mutation.mutateAsync({ analytics: true })}>
          Save test choice
        </button>
      </>
    );
  }
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  await screen.findByText("user:false");
  fireEvent.click(screen.getByRole("button", { name: "Save test choice" }));
  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(([, options]) => options?.method === "PUT"),
    ).toBe(true),
  );
  mockUserId = "other";
  view.rerender(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  await screen.findByText("other:false");
  resolveSave({
    ok: true,
    json: async () => ({ essential: true, analytics: true, marketing: false }),
  });
  await waitFor(() =>
    expect(client.getQueryData(["cookie-preferences", "user"])).toEqual({
      essential: true,
      analytics: true,
      marketing: false,
    }),
  );
  expect(screen.getByText("other:false")).toBeInTheDocument();
  expect(client.getQueryData(["cookie-preferences", "other"])).toEqual({
    essential: true,
    analytics: false,
    marketing: false,
  });
});
