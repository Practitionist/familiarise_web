/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { classifyError } from "@/lib/errors/classification/payment-error-classification";

import {
  DiscountCodeField,
  isDiscountRefusal,
  useDiscountCode,
} from "@/app/checkout/plans/components/DiscountCodeField";

type Harness = { refuse: (message: string, code?: string) => void };
let harness: Harness | null = null;

function Field() {
  const discount = useDiscountCode({
    amountPaise: 100000,
    consultantProfileId: "cp1",
  });
  harness = { refuse: discount.refuse };
  return (
    <DiscountCodeField
      discount={discount}
      formatPrice={(paise) => `₹${paise / 100}`}
    />
  );
}

function mockValidate(body: unknown, ok = true) {
  global.fetch = jest.fn(async () => {
    if (!ok) throw new Error("offline");
    return { json: async () => body };
  }) as unknown as typeof fetch;
}

async function apply(code: string) {
  fireEvent.change(screen.getByPlaceholderText("Enter discount code"), {
    target: { value: code },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  });
}

describe("DiscountCodeField", () => {
  it("shows a refused code inline, tied to the input, until the code is edited", async () => {
    mockValidate({ valid: false, message: "This discount code has expired" });
    render(<Field />);
    await apply("old10");

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("This discount code has expired");
    const input = screen.getByPlaceholderText("Enter discount code");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(input, { target: { value: "OLD1" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a validation network failure inline", async () => {
    mockValidate(null, false);
    render(<Field />);
    await apply("save5");
    expect(screen.getByRole("alert").textContent).toBe(
      "Failed to validate discount code",
    );
  });

  it("shows the applied chip with the rupees taken off", async () => {
    mockValidate({
      valid: true,
      code: "SAVE5",
      discountType: "PERCENTAGE",
      discountValue: 5,
      discountAmount: 5000,
    });
    render(<Field />);
    await apply("save5");
    expect(screen.getByText("SAVE5")).toBeTruthy();
    expect(screen.getByText("₹50 off")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops an applied code the checkout refused and says why in the field", async () => {
    mockValidate({
      valid: true,
      code: "SAVE5",
      discountType: "PERCENTAGE",
      discountValue: 5,
    });
    render(<Field />);
    await apply("save5");
    act(() =>
      harness?.refuse("This discount code has been fully redeemed.", "SAVE5"),
    );
    expect(screen.queryByText("SAVE5", { selector: "div" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(
      "This discount code has been fully redeemed.",
    );
    expect(
      (screen.getByPlaceholderText("Enter discount code") as HTMLInputElement)
        .value,
    ).toBe("SAVE5");
  });
});

describe("isDiscountRefusal", () => {
  it.each([
    { errorType: "DISCOUNT_EXHAUSTED_ERROR" },
    { errorType: "DISCOUNT_NOT_APPLICABLE_ERROR" },
    { errorType: "DISCOUNT_CODE_INVALID_ERROR" },
    { code: "DISCOUNT_EXHAUSTED" },
    { code: "DISCOUNT_NOT_APPLICABLE" },
  ])("treats %o as a code refusal", (refusal) => {
    expect(isDiscountRefusal(refusal)).toBe(true);
  });

  it("leaves payment and system failures to the toast", () => {
    expect(isDiscountRefusal({ errorType: "GST_CONFIG_INVALID_ERROR" })).toBe(
      false,
    );
    expect(isDiscountRefusal({ code: "RATE_LIMITED" })).toBe(false);
    expect(isDiscountRefusal({})).toBe(false);
  });
});

describe("checkout classification of an unknown code", () => {
  it("answers with the typed error the field recognises", () => {
    const refusal = Object.assign(
      new Error("That discount code is not valid for this purchase"),
      { code: "DISCOUNT_CODE_INVALID", httpStatus: 400 },
    );
    const classified = classifyError(refusal);
    expect(classified.errorType).toBe("DISCOUNT_CODE_INVALID_ERROR");
    expect(isDiscountRefusal({ errorType: classified.errorType })).toBe(true);
  });
});
