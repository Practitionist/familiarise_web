# Customers API, Saved Cards (RBI CoFT) & GDPR Erasure

Official citations:
- [Create a Customer (`POST /v1/customers`)](https://razorpay.com/docs/api/customers/create/)
- [Saved Cards Overview & RBI Tokenisation](https://razorpay.com/docs/payments/payment-methods/cards/features/saved-cards/)
- [Integrate Saved Cards on Standard Checkout](https://razorpay.com/docs/payments/payment-methods/cards/features/integrate-saved-cards/)

## Where It Lives in This Repo

| File | Responsibility |
|---|---|
| [`lib/payments/core/saved-card-customer.ts`](../../../../../lib/payments/core/saved-card-customer.ts) | `savedCardCustomerId(userId, gateway, isMockPayment)` — fail-soft entry point gated by `ENABLE_SAVED_CARDS`. If the Customer API fails or times out, returns `undefined` so checkout still succeeds without the save-card option. |
| [`lib/payments/core/razorpay.ts`](../../../../../lib/payments/core/razorpay.ts) | `ensureRazorpayCustomer(userId)` (`fail_existing: 0`, 8s timeout, CAS on `User.razorpayCustomerId`), `deleteRazorpayCustomerTokens(customerId)`, `eraseRazorpayCustomerPii(customerId, userId)`. |
| [`lib/payments/client/checkout-options.ts`](../../../../../lib/payments/client/checkout-options.ts) | Passes `customer_id` and `remember_customer: true` to `checkout.js` when `customerId` is present on the checkout order response. |

---

## 1. Creating / Linking a Razorpay Customer (`POST /v1/customers`)

```ts
// lib/payments/core/razorpay.ts
const customer = await withRazorpaySdkTimeout(
  "customers.create",
  () =>
    razorpayClient.customers.create({
      ...(name.length >= 3 ? { name } : {}),
      email: user.email,
      ...(contact ? { contact } : {}),
      fail_existing: 0,
    }),
  CUSTOMER_CREATE_TIMEOUT_MS, // 8_000 ms — called under checkout slot lock
);
```

### Verified Official API Rules (`POST /v1/customers`)

- **`fail_existing: 0` vs `1` (Default `1`)**:
  - When `fail_existing` is `"1"` (default), Razorpay rejects a duplicate `(email, contact)` with HTTP `400 BAD_REQUEST_ERROR` (`"Customer already exists for the merchant."`).
  - When `fail_existing: 0` (or `"0"`), Razorpay **fetches and returns the existing `cust_...` entity** instead of throwing an error.
  - **Why we use `fail_existing: 0` + CAS:** If a previous checkout created the Razorpay Customer but crashed before persisting `User.razorpayCustomerId`, `fail_existing: 0` re-links the same `cust_...` ID. We then write `User.razorpayCustomerId` via `updateMany({ where: { id: userId, razorpayCustomerId: null } })` and guard against `P2002` (unique constraint violation) so two different `User` rows can never share the same `razorpayCustomerId` and see each other's saved cards.
- **Field Validation Constraints**:
  - `name` (`string`, optional): **3 to 50 characters**. Supports alphabets, numbers, spaces, and `' - _ / ( ) . @`. Our code slices `user.name.trim().slice(0, 50)` and omits `name` if `< 3` chars.
  - `contact` (`string`, optional): **8 to 15 characters** including country code (`+` and digits only). Normalized via `normalizeRazorpayContact(user.phone)`.
  - `email` (`string`, optional): Valid email up to 64 characters.
  - `notes` (`object`, optional): Max 15 key-value pairs, 256 characters each.

---

## 2. How Saved Cards Work on Standard Checkout (RBI CoFT)

1. **No Raw Card Data Touches Our Servers**: Under RBI Card-on-File Tokenisation (CoFT) norms, neither Familiarise nor Razorpay stores raw PAN/card numbers. Card networks (Visa, Mastercard, RuPay, Diners, Amex) issue network/issuer tokens (`token_...`) tied to the `cust_...` entity.
2. **Order + Checkout Wiring**:
   - `createRazorpayOrder` passes `customer_id: customerId` when creating the order (`POST /v1/orders`).
   - `buildCheckoutOptions` passes `customer_id: customerId` and `remember_customer: true` to `new window.Razorpay(options)`.
3. **Customer Consent & OTP**:
   - Razorpay Standard Checkout renders its own RBI-compliant tokenisation consent checkbox (*"Securely save this card as per RBI guidelines"*). Do **not** build a custom save-card checkbox in our UI.
   - On repeat checkouts, the buyer authenticates saved cards on Checkout via OTP sent to their mobile number (or biometric auth) and enters only the 3-digit CVV.
4. **Customer Self-Service Portal**: Buyers can also view or revoke their tokenized cards across merchants directly on Razorpay's portal at `https://razorpay.com/flashcheckout/manage/`.

---

## 3. Account Erasure & GDPR / DPDP Compliance (`#1771 row 5`)

Razorpay provides **no `DELETE /v1/customers/:id` endpoint** — once a `cust_...` record exists on Razorpay, it cannot be deleted. When a user exercises right-to-erasure, we perform two operations in [`lib/payments/core/razorpay.ts`](../../../../../lib/payments/core/razorpay.ts):

1. **Delete all saved-card tokens (`deleteRazorpayCustomerTokens`)**:
   - Calls `razorpayClient.customers.fetchTokens(customerId)` (`GET /v1/customers/:id/tokens`).
   - Iterates through `tokens.items` and calls `razorpayClient.customers.deleteToken(customerId, token.id)` (`DELETE /v1/customers/:id/tokens/:token_id`).
2. **Overwrite Customer PII (`eraseRazorpayCustomerPii`)**:
   - Calls `razorpayClient.customers.edit(customerId, { name: "Erased user", email: "erased+<sha256_prefix>@familiarisenow.com" })` (`PUT /v1/customers/:id`).
   - **Quirk on `contact`:** The Edit Customer API provides no way to clear `contact` (`null`/`""` is rejected because `contact` must be 8–15 digits), so `contact` is left untouched while `name` and `email` are overwritten.
