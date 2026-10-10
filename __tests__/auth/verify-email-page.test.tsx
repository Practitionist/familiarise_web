/**
 * @jest-environment jsdom
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockVerifyEmail = jest.fn();
const mockSendVerificationOtp = jest.fn();
jest.mock("../../lib/auth-client", () => ({
  __esModule: true,
  emailOtp: {
    verifyEmail: (...a: unknown[]) => mockVerifyEmail(...a),
    sendVerificationOtp: (...a: unknown[]) => mockSendVerificationOtp(...a),
  },
  useSession: () => ({ data: null, isPending: false }),
}));

const mockReplace = jest.fn();
let mockQuery = "";
jest.mock("next/navigation", () => ({
  __esModule: true,
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockQuery),
}));

const mockToast = jest.fn();
jest.mock("../../hooks/use-toast", () => ({
  __esModule: true,
  useToast: () => ({ toast: mockToast }),
}));

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import VerifyEmail from "@/app/auth/verify-email/page";
import {
  readPendingVerificationEmail,
  stashPendingVerificationEmail,
} from "@/app/auth/pending-verification";

let container: HTMLDivElement;
let root: Root;

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function resendButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.startsWith("Resend code"),
  );
  if (!button) throw new Error("resend button missing");
  return button;
}

async function renderPage(query: string) {
  const params = new URLSearchParams(query);
  const email = params.get("email");
  if (email) stashPendingVerificationEmail(email);
  params.delete("email");
  mockQuery = params.toString();
  await act(async () => {
    root.render(<VerifyEmail />);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  sessionStorage.clear();
  jest.useRealTimers();
});

describe("verify email code page", () => {
  it("submits the digits and replaces to the callback for an onboarded user", async () => {
    mockVerifyEmail.mockResolvedValue({
      data: { status: true, token: "t", user: { onboardingCompleted: true } },
      error: null,
    });
    await renderPage("email=ada%40example.com&callbackUrl=%2Fcheckout%2F1");

    expect(container.textContent).toContain(
      "We emailed a 6-digit code to ada@example.com. It expires in 10 minutes.",
    );
    const input = container.querySelector<HTMLInputElement>("#code");
    if (!input) throw new Error("code input missing");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("inputmode")).toBe("numeric");

    await act(async () => typeInto(input, "12a 3456"));
    expect(input.value).toBe("123456");

    const form = container.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(mockVerifyEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "ada@example.com", otp: "123456" }),
    );
    expect(mockReplace).toHaveBeenCalledWith("/checkout/1");
    expect(readPendingVerificationEmail()).toBeNull();
  });

  it("sends a not-yet-onboarded user to onboarding with the callback", async () => {
    mockVerifyEmail.mockResolvedValue({
      data: { status: true, token: "t", user: { onboardingCompleted: false } },
      error: null,
    });
    await renderPage("email=ada%40example.com&callbackUrl=%2Finvite");
    const input = container.querySelector<HTMLInputElement>("#code");
    if (!input) throw new Error("code input missing");
    await act(async () => typeInto(input, "654321"));
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(mockReplace).toHaveBeenCalledWith(
      "/form/onboarding?callbackUrl=%2Finvite",
    );
  });

  it("holds resend behind a 60s cooldown and restarts it after sending", async () => {
    jest.useFakeTimers();
    mockSendVerificationOtp.mockResolvedValue({
      data: { success: true },
      error: null,
    });
    await renderPage("email=ada%40example.com");

    expect(resendButton().disabled).toBe(true);
    expect(resendButton().textContent).toBe("Resend code in 60s");

    for (let i = 0; i < 60; i++) {
      act(() => {
        jest.advanceTimersByTime(1000);
      });
    }
    expect(resendButton().disabled).toBe(false);

    await act(async () => {
      resendButton().click();
    });
    expect(mockSendVerificationOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "ada@example.com",
        type: "email-verification",
      }),
    );
    expect(resendButton().disabled).toBe(true);
    expect(resendButton().textContent).toBe("Resend code in 60s");
  });

  it("asks for the email when the link carries none, without a cooldown", async () => {
    await renderPage("");
    expect(container.querySelector("#email")).not.toBeNull();
    expect(resendButton().disabled).toBe(false);
  });
});
