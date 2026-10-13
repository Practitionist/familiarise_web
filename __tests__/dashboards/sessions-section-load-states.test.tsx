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
  signInHref: () => "/auth/signin?callbackUrl=%2Fdashboard%2Faccount",
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

jest.mock("../../components/dashboard/ConfirmDialog", () => {
  return {
    __esModule: true,
    // Test double: renders the trigger plus a confirm button carrying
    // the real confirmLabel, and surfaces a rejected onConfirm inline
    // the way the real dialog does.
    ConfirmDialog: ({
      trigger,
      onConfirm,
      confirmLabel,
    }: {
      trigger?: React.ReactNode;
      onConfirm: (ctx: unknown) => unknown;
      confirmLabel?: string;
    }) => {
      const [error, setError] = useState<string | null>(null);
      return (
        <div>
          {trigger}
          <button
            onClick={() => {
              setError(null);
              Promise.resolve()
                .then(() => onConfirm({}))
                .catch((e: Error) => setError(e.message));
            }}
          >
            {confirmLabel ?? "confirm"}
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
      );
    },
  };
});

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

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Sentry from "@sentry/nextjs";
import {
  PasswordSection,
  SessionsSection,
} from "../../components/dashboard/account/SignInSecuritySection";

const captureException = Sentry.captureException as jest.Mock;

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
});

const okList = (rows: unknown[]) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      sessions: rows,
      total: rows.length,
      nextCursor: null,
    }),
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

  it("a 500 reports once to Sentry; Retry clicks do not re-report", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await mount();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { subsystem: "auth", op: "sessions-list" },
        extra: expect.objectContaining({ status: 500 }),
      }),
    );

    const retry = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    );
    await act(async () => {
      retry?.click();
    });
    await flush();

    // One event per mount: a broken backend must not turn every Retry
    // click into a Sentry event.
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("a 401 never reports — a dead session is an expected flow", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    await mount();

    expect(text()).toContain("Sign in again");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("a 429 never reports — the limiter working is not a defect", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    });

    await mount();

    expect(text()).toContain("We couldn't load your sessions.");
    expect(captureException).not.toHaveBeenCalled();
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

  it("per-row revoke on a dead session signs out instead of erroring", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        okList([session("s-old", false), session("s-cur", true)]),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
      });

    await mount();

    const rowSignOut = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Sign out",
    );
    expect(rowSignOut).toBeDefined();
    await act(async () => {
      rowSignOut?.click();
    });
    await flush();
    const confirm = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Sign out device",
    );
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm?.click();
    });
    await flush();

    const { signOutEverywhere } = jest.requireMock(
      "../../lib/auth/sign-out",
    ) as unknown as { signOutEverywhere: jest.Mock };
    expect(signOutEverywhere).toHaveBeenCalledWith(
      "/auth/signin?callbackUrl=%2Fdashboard%2Faccount",
    );
  });

  it("per-row revoke on 429 shows the rate-limit message inline", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        okList([session("s-old", false), session("s-cur", true)]),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({}),
      });

    await mount();

    const rowSignOut = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Sign out",
    );
    await act(async () => {
      rowSignOut?.click();
    });
    await flush();
    const confirm = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Sign out device",
    );
    await act(async () => {
      confirm?.click();
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Too many requests");
  });

  it("password change revokes other sessions in the same request", async () => {
    const { authClient } = jest.requireMock(
      "../../lib/auth-client",
    ) as unknown as {
      authClient: { changePassword: jest.Mock };
    };
    authClient.changePassword.mockResolvedValue({});

    async function submitPasswordForm(): Promise<void> {
      const setInput = (id: string, value: string) => {
        const el = document.getElementById(id) as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      setInput("password-current", "old-password-1");
      setInput("password-next", "new-password-1");
      setInput("password-confirm", "new-password-1");
      const form = container.querySelector("form");
      expect(form).not.toBeNull();
      await act(async () => {
        form?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await flush();
    }

    async function mountPassword(): Promise<void> {
      await act(async () => {
        root = createRoot(container);
        root.render(<PasswordSection />);
      });
      await flush();
    }

    await mountPassword();
    await submitPasswordForm();
    // One request: BetterAuth ends the other sessions itself.
    expect(authClient.changePassword).toHaveBeenCalledWith(
      expect.objectContaining({ revokeOtherSessions: true }),
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Password changed",
        description: "Your other devices were signed out.",
      }),
    );
  });

  it("a failed revoke reports to Sentry unless it is 401/429", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        okList([session("s-old", false), session("s-cur", true)]),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

    await mount();

    const others = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Sign out other devices",
    );
    await act(async () => {
      others?.click();
    });
    await flush();

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { subsystem: "auth", op: "sessions-revoke-others" },
      }),
    );
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
