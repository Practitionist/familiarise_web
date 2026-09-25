import { buildCheckoutOptions } from "@/lib/payments/client/checkout-options";

// #1771 — saved cards and the EMI hide block are opt-in, so org sheets stay unchanged.
const base = (extra: Partial<Parameters<typeof buildCheckoutOptions>[0]>) =>
  buildCheckoutOptions({
    keyId: "rzp_test_key",
    orderId: "order_1",
    amount: 50000,
    currency: "INR",
    name: "Familiarise",
    description: "Service Payment",
    handler: () => undefined,
    ...extra,
  });

describe("buildCheckoutOptions", () => {
  it("omits customer and EMI config by default", () => {
    const options = base({});
    expect(options).not.toHaveProperty("customer_id");
    expect(options).not.toHaveProperty("remember_customer");
    expect(options).not.toHaveProperty("config");
    expect(options).not.toHaveProperty("modal");
    expect(options.order_id).toBe("order_1");
  });

  it("adds customer_id + remember_customer and the EMI hide block when asked", () => {
    const options = base({ customerId: "cust_1", hideEmi: true });
    expect(options.customer_id).toBe("cust_1");
    expect(options.remember_customer).toBe(true);
    expect(options.config?.display.hide).toEqual([{ method: "emi" }]);
  });
});
