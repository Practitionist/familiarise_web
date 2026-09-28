/**
 * One builder for every Razorpay Checkout sheet the app opens (#1771).
 *
 * Pure and dependency-free so client components can import it. Saved cards
 * (`customer_id` + `remember_customer`) and the EMI hide block are opt-in, so
 * the organisation wallet, invoice and overage sheets build exactly the
 * options they always did.
 */

/** #1780 row 1 — the smallest total the "pay in instalments" line is shown for (₹3,000). */
export const EMI_MIN_PAISE = 300000;

export interface RazorpayCheckoutResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

export interface RazorpayCheckoutPrefill {
  name?: string;
  email?: string;
  contact?: string;
}

interface RazorpayDisplayConfig {
  display: {
    hide: { method: string }[];
    preferences: { show_default_blocks: boolean };
  };
}

export interface RazorpayCheckoutOptions {
  key: string | undefined;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: RazorpayCheckoutResponse) => void;
  prefill?: RazorpayCheckoutPrefill;
  theme?: { color: string };
  modal?: { ondismiss?: () => void };
  customer_id?: string;
  remember_customer?: boolean;
  config?: RazorpayDisplayConfig;
  /** Seconds before Checkout closes itself and fires `ondismiss`. */
  timeout?: number;
}

export interface BuildCheckoutOptionsInput {
  keyId: string | undefined;
  orderId: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: RazorpayCheckoutPrefill;
  theme?: { color: string };
  /**
   * A Razorpay Customer id (#1771 row 1). Checkout then shows its own RBI
   * tokenisation consent box, so the app renders no checkbox of its own.
   */
  customerId?: string;
  rememberCustomer?: boolean;
  /** Hides the EMI block while `ENABLE_CHECKOUT_EMI` is off (#1780 row 1). */
  hideEmi?: boolean;
  /**
   * #1861 L1 — when the slot hold behind this order ends (ISO or Date). The
   * sheet then times out a minute before it, so nobody starts paying for a
   * slot that is about to be offered to someone else.
   */
  holdExpiresAt?: string | Date | null;
  handler: (response: RazorpayCheckoutResponse) => void;
  onDismiss?: () => void;
}

const HIDE_EMI_CONFIG: RazorpayDisplayConfig = {
  display: {
    hide: [{ method: "emi" }],
    preferences: { show_default_blocks: true },
  },
};

/** Checkout's `timeout` for a hold ending at `holdExpiresAt`; undefined when unknown. */
export function holdTimeoutSeconds(
  holdExpiresAt: string | Date | null | undefined,
): number | undefined {
  if (!holdExpiresAt) return undefined;
  const endsAt = new Date(holdExpiresAt).getTime();
  if (Number.isNaN(endsAt)) return undefined;
  const secondsLeft = Math.floor((endsAt - Date.now()) / 1000);
  return Math.max(60, secondsLeft - 60);
}

export function buildCheckoutOptions(
  input: BuildCheckoutOptionsInput,
): RazorpayCheckoutOptions {
  const timeout = holdTimeoutSeconds(input.holdExpiresAt);
  return {
    key: input.keyId,
    amount: input.amount,
    currency: input.currency,
    name: input.name,
    description: input.description,
    order_id: input.orderId,
    handler: input.handler,
    ...(input.prefill ? { prefill: input.prefill } : {}),
    ...(input.theme ? { theme: input.theme } : {}),
    ...(input.onDismiss ? { modal: { ondismiss: input.onDismiss } } : {}),
    ...(input.customerId
      ? {
          customer_id: input.customerId,
          remember_customer: input.rememberCustomer ?? true,
        }
      : {}),
    ...(input.hideEmi ? { config: HIDE_EMI_CONFIG } : {}),
    ...(timeout === undefined ? {} : { timeout }),
  };
}
