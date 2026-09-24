/**
 * One builder for every Razorpay Checkout sheet the app opens (#1771).
 *
 * Pure and dependency-free so client components can import it. Saved cards
 * (`customer_id` + `remember_customer`) and the EMI hide block are opt-in, so
 * the organisation wallet, invoice and overage sheets build exactly the
 * options they always did.
 */

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
  handler: (response: RazorpayCheckoutResponse) => void;
  onDismiss?: () => void;
}

const HIDE_EMI_CONFIG: RazorpayDisplayConfig = {
  display: {
    hide: [{ method: "emi" }],
    preferences: { show_default_blocks: true },
  },
};

export function buildCheckoutOptions(
  input: BuildCheckoutOptionsInput,
): RazorpayCheckoutOptions {
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
  };
}
