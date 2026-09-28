/**
 * @jest-environment jsdom
 */

/**
 * SessionsSection load states (#1856).
 *
 * A 401 means THIS session is gone (revoked elsewhere, expired) —
 * offering Retry on a dead cookie can never succeed, so the section
 * says so and points at sign-in. Anything else (500/503/429/network)
 * is transient and keeps the Retry button. A refresh failure with a
 * loaded list keeps the stale rows (flagged by toast) instead of
 * blanking the section.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Single stable toast fn: useToast() must return a referentially stable
// `toast` or SessionsSection's `load` callback (dep: [toast]) is recreated
// every render and the mount effect refetches forever.
jest.mock("../../hooks/use-toast", () => {
  const toast = jest.fn();
  return {
    __esModule: true,
    useToast: () => ({ toast }),
  };
});

jest.mock("../../lib/auth-client", () => ({
  __esModule: true,
  authClient: {
    changePassword: jest.fn(),
    listAccounts: jest.fn(),
    unlinkAccount: jest.fn(),
  },
  useSession: () => ({ data: null }),
}));

jest.mock("../../lib/auth/sign-out", () => ({
  __esModule: true,
  signOutEverywhere: jest.fn(),
}));

jest.mock("../../lib/auth-broadcast", () => ({
  __esModule: true,
  postAuthSync: jest.fn(),
}));

jest.mock("../../components/auth/auth-icons", () => ({
  __esModule: true,
  PROVIDER_ICONS: {},
}));

jest.mock("../../components/dashboard/Section", () => ({
  __esModule: true,
  Section: ({
    title,
    children,
  }: {
    title: string;
    children: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

jest.mock("../../components/dashboard/ConfirmDialog", () => ({
  __esModule: true,
  ConfirmDialog: ({ trigger }: { trigger: React.ReactNode }) => (
    <div>{trigger}</div>
  ),
}));

jest.mock("../../components/dashboard/StatusBadge", () => ({
  __esModule: true,
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
}));

jest.mock("../../components/dashboard/SettingsLayout", () => ({
  __esModule: true,
  FieldError: () => null,
  SettingsSaveBar: () => null,
  invalidProps: () => ({}),
}));

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionsSection } from "../../components/dashboard/account/SignInSecuritySection";

// The stable toast fn from the mock (no hook call — rules-of-hooks).
const { toast } = (
  jest.requireMock("../../hooks/use-toast") as {
    useToast: () => { toast: jest.Mock };
  }
).useToast();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = global.fetch;

const session = (id: string, isCurrent: boolean) => ({
  id,
  label: `Device ${id}`,
  ipAddress: "1.2.3.4",
  createdAt: "2026-09-28T08:00:00.000Z",
  lastSeenAt: "2026-09-28T08:05:00.000Z",
  expiresAt: "2026-10-28T08:00:00.000Z",
  isCurrent,
  isImpersonated: false,
});

const okList = (rows: unknown[]) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ sessions: rows }),
  });

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("SessionsSection load states (#1856)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    global.fetch = realFetch;
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(<SessionsSection />);
    });
    await flush();
  }

  function text(): string {
    return container.textContent ?? "";
  }

  it("a 401 says the session ended and offers sign-in, never Retry", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    await mount();

    expect(text()).toContain("Your session ended");
    expect(text()).toContain("Sign in again");
    expect(text()).not.toContain("Retry");
    expect(text()).not.toContain("Device s1");
  });

  it("a 500 offers Retry, and Retry loads the list", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await mount();

    expect(text()).toContain("We couldn't load your sessions.");
    expect(text()).toContain("Retry");

    (global.fetch as jest.Mock).mockResolvedValue(
      okList([session("s1", true)]),
    );
    const retry = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
    });
    await flush();

    expect(text()).toContain("Device s1");
    expect(text()).toContain("This device");
  });

  it("lists rows with per-row Sign out only on the non-current device", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      okList([session("s-new", false), session("s-cur", true)]),
    );

    await mount();

    expect(text()).toContain("Device s-new");
    expect(text()).toContain("Device s-cur");
    const signOuts = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent === "Sign out",
    );
    expect(signOuts).toHaveLength(1);
  });

  it("a failed sign-out-others toasts and keeps the stale list", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      okList([session("s-new", false), session("s-cur", true)]),
    );

    await mount();
    expect(text()).toContain("Device s-new");

    (global.fetch as jest.Mock).mockRejectedValue(new Error("down"));
    const others = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Sign out other devices",
    );
    expect(others?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      others?.click();
    });
    await flush();

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "We couldn't end your other sessions. Please try again.",
      }),
    );
    // Both rows still listed — nothing was blanked.
    expect(text()).toContain("Device s-new");
    expect(text()).toContain("Device s-cur");
  });
});
