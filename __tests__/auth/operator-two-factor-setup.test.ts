import { TextDecoder, TextEncoder } from "node:util";
import { webcrypto } from "node:crypto";

Object.assign(globalThis, {
  TextEncoder,
  TextDecoder,
  IS_REACT_ACT_ENVIRONMENT: true,
});
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
}

import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { z } from "zod";

const mockGetSession = jest.fn();
const mockEnable = jest.fn();
const mockVerifyTotp = jest.fn();
const mockGenerateBackupCodes = jest.fn();

jest.mock("../../lib/auth-client", () => ({
  authClient: {
    getSession: (...args: unknown[]) => mockGetSession(...args),
    twoFactor: {
      enable: (...args: unknown[]) => mockEnable(...args),
      verifyTotp: (...args: unknown[]) => mockVerifyTotp(...args),
      generateBackupCodes: (...args: unknown[]) =>
        mockGenerateBackupCodes(...args),
    },
  },
  signOut: jest.fn(),
}));

jest.mock("../../lib/auth/sign-out", () => ({
  signOutEverywhere: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/auth-guard", () => ({
  requireOperatorAwaitingTwoFactor: jest.fn().mockResolvedValue({
    id: "op-1",
    role: "STAFF",
  }),
}));

jest.mock("../../components/ui/use-toast", () => ({
  toast: jest.fn(),
}));

import { signOutEverywhere } from "@/lib/auth/sign-out";
import TwoFactorSetupPage from "@/app/auth/two-factor/setup/page";
import { TwoFactorSettings } from "@/components/auth/TwoFactorSettings";
import {
  makeQueryClient,
  redirectOnTwoFactorPreconditionError,
} from "@/providers/ReactQueryProvider";

function setReactInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  );
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("seed-two-factor deterministic derivation & XChaCha20 round-trip", () => {
  const originalSecret = process.env.BETTER_AUTH_SECRET;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-32-chars-min";
  });

  afterAll(() => {
    process.env.BETTER_AUTH_SECRET = originalSecret;
  });

  it("throws when BETTER_AUTH_SECRET is unset or blank", async () => {
    const { requireAuthSecret } =
      await import("@/prisma/seedFiles/seed-two-factor");
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => requireAuthSecret()).toThrow(/BETTER_AUTH_SECRET/);

    process.env.BETTER_AUTH_SECRET = "   ";
    expect(() => requireAuthSecret()).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("round-trips encrypted secret and backup codes with Better Auth symmetricDecrypt and verifies TOTP", async () => {
    const { symmetricDecrypt } = await import("better-auth/crypto");
    const { createOTP } = await import("@better-auth/utils/otp");
    const {
      buildSeedOperatorTwoFactorRow,
      computeSeedOperatorTotp,
      deriveSeedOperatorBackupCodes,
      deriveSeedOperatorTotpSecret,
      requireAuthSecret,
    } = await import("@/prisma/seedFiles/seed-two-factor");

    const authSecret = requireAuthSecret();
    const email = "Staff.Operator@Familiarise.com";
    const row = await buildSeedOperatorTwoFactorRow("user-staff-1", email);

    expect(row.userId).toBe("user-staff-1");
    expect(row.verified).toBe(true);

    const decryptedSecret = await symmetricDecrypt({
      key: authSecret,
      data: row.secret,
    });
    expect(decryptedSecret).toBe(deriveSeedOperatorTotpSecret(email));

    const decryptedBackupCodesRaw = await symmetricDecrypt({
      key: authSecret,
      data: row.backupCodes,
    });
    const parsedBackupCodes = z
      .array(z.string())
      .parse(JSON.parse(decryptedBackupCodesRaw));
    expect(parsedBackupCodes).toHaveLength(10);
    expect(parsedBackupCodes).toEqual(deriveSeedOperatorBackupCodes(email));
    for (const backupCode of parsedBackupCodes) {
      expect(backupCode).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);
    }

    const fixedNow = new Date("2026-10-10T08:00:00Z");
    const code = computeSeedOperatorTotp(email, fixedNow);
    expect(code).toMatch(/^\d{6}$/);

    jest.useFakeTimers().setSystemTime(fixedNow);
    try {
      const otp = createOTP(decryptedSecret, { period: 30, digits: 6 });
      await expect(otp.verify(code)).resolves.toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("ReactQueryProvider central HTTP 428 precondition handler", () => {
  it("redirects browser queries and mutations throwing status 428 to /auth/two-factor/setup", async () => {
    const assignMock = jest.fn();

    const err428 = Object.assign(
      new Error(
        "Set up two-factor authentication before using the back office.",
      ),
      { status: 428 },
    );
    redirectOnTwoFactorPreconditionError(err428, assignMock);
    expect(assignMock).toHaveBeenCalledWith("/auth/two-factor/setup");

    assignMock.mockClear();
    const err500 = Object.assign(new Error("Internal error"), {
      status: 500,
    });
    redirectOnTwoFactorPreconditionError(err500, assignMock);
    expect(assignMock).not.toHaveBeenCalled();

    const client = makeQueryClient();
    expect(typeof client.getQueryCache().config.onError).toBe("function");
    expect(typeof client.getMutationCache().config.onError).toBe("function");
    // Passing a second TanStack metadata argument (even a function) must NOT hijack navigate:
    const fakeQueryMeta = jest.fn();
    client.getQueryCache().config.onError!(err428, fakeQueryMeta as never);
    expect(fakeQueryMeta).not.toHaveBeenCalled();
  });
});

describe("TwoFactorSettings backup code gate & TwoFactorSetupPage escape hatch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    mockGetSession.mockResolvedValue({
      data: { user: { twoFactorEnabled: false } },
    });
    mockEnable.mockResolvedValue({
      data: {
        method: "totp",
        totpURI:
          "otpauth://totp/Familiarise:staff@example.com?secret=JBSWY3DPEHPK3PXP",
        backupCodes: ["abcde-12345", "fghij-67890"],
      },
      error: null,
    });
    mockVerifyTotp.mockResolvedValue({ data: { status: true }, error: null });
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("disables Continue until the backup-code checkbox is ticked and supports Copy/Download", async () => {
    await act(async () => {
      root.render(
        React.createElement(TwoFactorSettings, { continueHref: "/dashboard" }),
      );
    });

    const passwordInput = container.querySelector("#tfa-enable-password");
    expect(passwordInput).not.toBeNull();

    await act(async () => {
      if (passwordInput instanceof HTMLInputElement) {
        setReactInputValue(passwordInput, "SeedPass123!");
      }
    });

    const setupBtn = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Set up two-factor"),
    );
    expect(setupBtn).toBeDefined();

    await act(async () => {
      setupBtn?.click();
    });

    const otpInput = container.querySelector(
      'input[aria-label="Six digit code"]',
    );
    expect(otpInput).not.toBeNull();

    await act(async () => {
      if (otpInput instanceof HTMLInputElement) {
        setReactInputValue(otpInput, "123456");
      }
    });

    const verifyBtn = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent === "Verify",
    );
    expect(verifyBtn).toBeDefined();

    await act(async () => {
      verifyBtn?.click();
    });

    expect(container.textContent).toContain(
      "Leaving or reloading this page loses these codes. You can generate new ones later from Settings using your password.",
    );
    expect(container.textContent).toContain(
      "Lost your authenticator? Use a backup code, or ask an admin to reset your two-factor authentication from the Team page.",
    );

    const continueBtn = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("saved these codes"),
    );
    expect(continueBtn).toBeDefined();
    expect(continueBtn?.disabled).toBe(true);

    const copyBtn = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent === "Copy codes",
    );
    const { toast: toastMock } = await import("@/components/ui/use-toast");
    await act(async () => {
      copyBtn?.click();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "abcde-12345\nfghij-67890",
    );
    expect(toastMock).toHaveBeenCalledWith({
      title: "Backup codes copied to clipboard",
    });

    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockRejectedValue(new Error("Clipboard denied")),
      },
    });
    await act(async () => {
      copyBtn?.click();
    });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );

    const checkbox = container.querySelector('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();

    await act(async () => {
      if (checkbox instanceof HTMLInputElement) {
        checkbox.click();
      }
    });

    expect(continueBtn?.disabled).toBe(false);
  });

  it("renders setup instructions, escape-hatch sign-out button, and home link", async () => {
    const page = await TwoFactorSetupPage();
    await act(async () => {
      root.render(page);
    });

    expect(container.textContent).toContain(
      "Staff accounts can view customer records and issue refunds, so two-factor authentication is required on every sign-in.",
    );

    const homeLink = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Back to Familiarise home"),
    );
    expect(homeLink?.getAttribute("href")).toBe("/");

    const signOutBtn = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent === "Sign out",
    );
    expect(signOutBtn).toBeDefined();
    await act(async () => {
      signOutBtn?.click();
    });
    expect(signOutEverywhere).toHaveBeenCalled();
  });
});
