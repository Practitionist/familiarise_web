/**
 * @jest-environment node
 */

// #1771 row 1 — one Customer per buyer, and nothing at all while the flag is off.
process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_SECRET = "rzp_test_secret";

const rzp = { customersCreate: jest.fn(), ordersCreate: jest.fn() };
jest.mock("razorpay", () =>
  jest.fn().mockImplementation(() => ({
    customers: { create: (...a: unknown[]) => rzp.customersCreate(...a) },
    orders: { create: (...a: unknown[]) => rzp.ordersCreate(...a) },
  })),
);

const row: { razorpayCustomerId: string | null } = { razorpayCustomerId: null };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(async () => ({
        ...row,
        name: "Asha Rao",
        email: "asha@example.com",
        phone: "+919812345678",
      })),
      updateMany: jest.fn(async ({ data }) => {
        if (row.razorpayCustomerId) return { count: 0 };
        row.razorpayCustomerId = data.razorpayCustomerId;
        return { count: 1 };
      }),
    },
  },
}));

const flags = { ENABLE_SAVED_CARDS: true };
jest.mock("../../lib/feature-flags", () => ({
  get ENABLE_SAVED_CARDS() {
    return flags.ENABLE_SAVED_CARDS;
  },
}));

import {
  createRazorpayOrder,
  ensureRazorpayCustomer,
} from "@/lib/payments/core/razorpay";
import { savedCardCustomerId } from "@/lib/payments/core/saved-card-customer";

beforeEach(() => {
  row.razorpayCustomerId = null;
  rzp.customersCreate.mockResolvedValue({ id: "cust_1" });
  rzp.ordersCreate.mockImplementation(async (body) => ({
    id: "order_1",
    amount: body.amount,
    currency: body.currency,
    status: "created",
  }));
});

it("creates the Customer once and reuses the stored id", async () => {
  await expect(ensureRazorpayCustomer("u1")).resolves.toBe("cust_1");
  await expect(ensureRazorpayCustomer("u1")).resolves.toBe("cust_1");
  expect(rzp.customersCreate).toHaveBeenCalledTimes(1);
  expect(rzp.customersCreate.mock.calls[0][0]).toMatchObject({
    fail_existing: 0,
  });
});

it("flag off: no Customer and no customer_id on the order", async () => {
  flags.ENABLE_SAVED_CARDS = false;
  const customerId = await savedCardCustomerId("u1");
  const order = await createRazorpayOrder({
    amount: 50000,
    currency: "INR",
    metadata: {},
    paymentGateway: "RAZORPAY",
    customerId,
  });
  expect(customerId).toBeUndefined();
  expect(rzp.customersCreate).not.toHaveBeenCalled();
  expect(rzp.ordersCreate.mock.calls[0][0]).not.toHaveProperty("customer_id");
  expect(order).not.toHaveProperty("customerId");
});
