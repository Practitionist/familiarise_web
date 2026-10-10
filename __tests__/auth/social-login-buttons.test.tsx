/**
 * @jest-environment jsdom
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockSocial = jest.fn();
jest.mock("../../lib/auth-client", () => ({
  __esModule: true,
  signIn: { social: (...a: unknown[]) => mockSocial(...a) },
}));

const mockToast = jest.fn();
jest.mock("../../hooks/use-toast", () => ({
  __esModule: true,
  useToast: () => ({ toast: mockToast }),
}));

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import { SocialProvidersProvider } from "@/components/auth/social-providers-context";
import type { AuthProviderId } from "@/lib/auth-providers";
import { UNREACHABLE } from "@/lib/labels/auth-errors";

let container: HTMLDivElement;
let root: Root;

async function renderButtons(providers: AuthProviderId[]) {
  await act(async () => {
    root.render(
      <SocialProvidersProvider providers={providers}>
        <SocialLoginButtons
          callbackURL="/dashboard"
          errorCallbackURL="/auth/signup"
          isLoading={false}
        />
      </SocialProvidersProvider>,
    );
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SocialLoginButtons", () => {
  it("renders only the configured providers, and nothing when none are", async () => {
    await renderButtons(["google"]);
    expect(buttons().map((b) => b.textContent)).toEqual(["Google"]);

    await renderButtons([]);
    expect(container.innerHTML).toBe("");
  });

  it("disables every provider while one is in flight and re-enables on error", async () => {
    let settle: (value: unknown) => void = () => {};
    mockSocial.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await renderButtons(["github", "google"]);

    await act(async () => {
      buttons()[0].click();
    });
    expect(mockSocial).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github",
        errorCallbackURL: "/auth/signup",
      }),
    );
    expect(buttons().every((b) => b.disabled)).toBe(true);

    await act(async () => {
      settle({ data: null, error: { status: 503 } });
    });
    expect(buttons().every((b) => !b.disabled)).toBe(true);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: UNREACHABLE.title,
        variant: "destructive",
      }),
    );
  });

  it("treats a thrown request as unreachable", async () => {
    mockSocial.mockRejectedValue(new TypeError("Failed to fetch"));
    await renderButtons(["google"]);
    await act(async () => {
      buttons()[0].click();
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: UNREACHABLE.title }),
    );
    expect(buttons()[0].disabled).toBe(false);
  });
});
