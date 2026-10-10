/**
 * The two-factor challenge page: an already-finished challenge (another tab)
 * redirects instead of showing "expired", and an ended challenge offers
 * "Sign in again" with the same callback.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const replace = jest.fn();
// Stable identity: the page's session-check effect lists `router` in its deps.
const router = { replace };
const searchParams = new URLSearchParams("callbackUrl=/dashboard/ops");
jest.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => searchParams,
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

const getSession = jest.fn();
const verifyTotp = jest.fn();
const verifyBackupCode = jest.fn();
jest.mock("../../lib/auth-client", () => ({
  authClient: {
    getSession: (...args: unknown[]) => getSession(...args),
    twoFactor: {
      verifyTotp: (...args: unknown[]) => verifyTotp(...args),
      verifyBackupCode: (...args: unknown[]) => verifyBackupCode(...args),
    },
  },
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import TwoFactorChallengePage from "../../app/auth/two-factor/page";

let container: HTMLDivElement;
let root: Root;

const signedOut = { data: null, error: null };
const signedIn = { data: { user: { id: "u1" } }, error: null };

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  const form = container.querySelector("form");
  await act(async () => {
    form?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await flush();
}

function codeInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("#two-factor-code");
  if (!input) throw new Error("code input not rendered");
  return input;
}

async function render() {
  await act(async () => {
    root.render(<TwoFactorChallengePage />);
  });
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TwoFactorChallengePage", () => {
  it("redirects on mount when the browser is already signed in", async () => {
    getSession.mockResolvedValue(signedIn);
    await render();
    expect(replace).toHaveBeenCalledWith("/dashboard/ops");
  });

  it("offers 'Sign in again' with the same callback once the challenge has ended", async () => {
    getSession.mockResolvedValue(signedOut);
    verifyTotp.mockResolvedValue({
      data: null,
      error: { code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE", status: 400 },
    });
    await render();
    typeInto(codeInput(), "123456");
    await submit();

    expect(replace).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Too many wrong codes");
    const again = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent === "Sign in again",
    );
    expect(again?.getAttribute("href")).toBe(
      "/auth/signin?callbackUrl=%2Fdashboard%2Fops",
    );
    expect(codeInput().disabled).toBe(true);
    expect(codeInput().getAttribute("aria-describedby")).toBe(
      "two-factor-error",
    );
  });

  it("redirects instead of showing 'expired' when another tab finished the challenge", async () => {
    getSession.mockResolvedValueOnce(signedOut).mockResolvedValueOnce(signedIn);
    verifyTotp.mockResolvedValue({
      data: null,
      error: { code: "INVALID_TWO_FACTOR_COOKIE", status: 401 },
    });
    await render();
    typeInto(codeInput(), "123456");
    await submit();

    expect(replace).toHaveBeenCalledWith("/dashboard/ops");
    expect(container.textContent).not.toContain("Your verification expired");
  });

  it("submits backup codes trimmed, with autofill off", async () => {
    getSession.mockResolvedValue(signedOut);
    verifyBackupCode.mockResolvedValue({
      data: null,
      error: { code: "INVALID_BACKUP_CODE", status: 401 },
    });
    await render();
    const toggle = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Use a backup code"),
    );
    act(() => toggle?.click());
    expect(codeInput().getAttribute("autocomplete")).toBe("off");

    typeInto(codeInput(), "  abcde-fghjk ");
    await submit();

    expect(verifyBackupCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: "abcde-fghjk" }),
    );
  });
});
