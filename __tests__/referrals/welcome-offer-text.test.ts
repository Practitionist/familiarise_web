/**
 * @jest-environment node
 */

/** The friend offer names the order floor and that a low-priced session can earn less, from config alone. */
import { welcomeOfferText } from "@/lib/referrals/promo-math";

const inr = (paise: number) => `₹${paise / 100}`;

it("states the percentage, the ceiling, the order floor and the low-price caveat", () => {
  const text = welcomeOfferText(
    { discountPercent: 15, discountMaxPaise: 30_000, minOrderPaise: 50_000 },
    inr,
  );
  expect(text).toBe(
    "15% off your first booking, up to ₹300 on orders of ₹500 or more, and it may be lower on low-priced sessions",
  );
});

it("drops the floor clause when the programme sets no minimum order", () => {
  const text = welcomeOfferText(
    { discountPercent: 10, discountMaxPaise: 20_000, minOrderPaise: 0 },
    inr,
  );
  expect(text).not.toContain("orders of");
  expect(text).toContain("may be lower on low-priced sessions");
});
