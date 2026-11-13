"use client";

/**
 * Billing-state picker for the GST place of supply.
 *
 * Required on a domestic buyer-paid checkout: CGST Rule 46(f) proviso puts the
 * recipient's state on every invoice for a service supplied online, and the
 * server refuses the checkout without it. Org-funded and international
 * checkouts get no consumer invoice, so there the field stays optional.
 *
 * Submits the 2-digit NUMERIC code, which is what the GST portal, the invoice
 * and `lib/compliance/gst.ts` all compare on. Once a buyer picks a state,
 * checkout remembers it on their consultee profile and this field arrives
 * pre-filled next time.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGstRegistered } from "@/components/pricing/BuyerPriceProvider";
import { useSession } from "@/lib/auth-client";
import { GST_STATE_OPTIONS } from "@/lib/compliance/state-codes";
import { BUYER_STATE_REQUIRED_MESSAGE } from "@/schemas/checkout";

export interface BillingStateSelectProps {
  /** The 2-digit numeric state code, or null when nothing has been chosen. */
  value: string | null;
  onChange: (stateCode: string | null) => void;
  required: boolean;
  /** Shown under the field once a submit was blocked on it. */
  error: string | null;
  disabled?: boolean;
}

/** Sentinel for the "no answer" option. Radix Select forbids an empty-string
 *  item value. */
const NOT_SPECIFIED = "__unspecified__";

export function BillingStateSelect({
  value,
  onChange,
  required,
  error,
  disabled,
}: Readonly<BillingStateSelectProps>) {
  const gstRegistered = useGstRegistered();
  return (
    <div className="grid gap-2">
      <Label htmlFor="billing-state">
        {gstRegistered ? "Billing state (for GST)" : "Billing state"}
      </Label>
      <Select
        value={value ?? (required ? "" : NOT_SPECIFIED)}
        onValueChange={(next) => onChange(next === NOT_SPECIFIED ? null : next)}
        disabled={disabled}
        required={required}
      >
        <SelectTrigger
          id="billing-state"
          className="w-full"
          aria-invalid={error ? true : undefined}
          aria-describedby="billing-state-help"
        >
          <SelectValue placeholder="Select your state" />
        </SelectTrigger>
        <SelectContent>
          {required ? null : (
            <SelectItem value={NOT_SPECIFIED}>Not specified</SelectItem>
          )}
          {GST_STATE_OPTIONS.map((option) => (
            <SelectItem key={option.code} value={option.code}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? (
        <p id="billing-state-help" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        <p id="billing-state-help" className="text-xs text-muted-foreground">
          {required
            ? gstRegistered
              ? "Needed for your GST invoice."
              : "Needed for your receipt and tax records."
            : "Optional for this booking."}
        </p>
      )}
    </div>
  );
}

export interface UseBillingStateResult {
  /** Spread straight onto `<BillingStateSelect />`. */
  selectProps: BillingStateSelectProps;
  /** Shows the inline error and returns false when a required state is missing. */
  validate: () => boolean;
  /**
   * Spread straight into a checkout POST body. Omits the key when no state is
   * chosen, which is what `createCheckoutData` expects for "not answered".
   */
  bodyField: { consumerStateCode?: string };
}

/**
 * Owns the billing-state answer for one checkout page: the local value, the
 * pre-fill from the buyer's remembered profile state, whether the rail needs
 * one, and the body field the page sends.
 *
 * The pre-fill needs the latch: the checkout context resolves after first
 * paint, so without one, a buyer who answers before it lands would have their
 * answer overwritten by the stored value a moment later.
 */
export function useBillingState(
  /** The checkout context: the remembered state and whether the buyer is abroad. */
  taxContext: { billingStateCode: string | null; isInternational: boolean },
  /** The org the buyer chose to bill, or null for a personal payment. */
  organizationId: string | null,
): UseBillingStateResult {
  const { billingStateCode: initial, isInternational } = taxContext;
  const [value, setValue] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);
  const [submitBlocked, setSubmitBlocked] = useState(false);
  const { data: session } = useSession();

  useEffect(() => {
    if (answered) return;
    setValue(initial);
  }, [initial, answered]);

  // Only WALLET/INVOICE/LICENSE bill the org; an org with no rail falls back to PERSONAL.
  const orgFunded = useMemo(() => {
    if (!organizationId) return false;
    const fundingSource = session?.user?.organizationMemberships?.find(
      (m) => m.organizationId === organizationId,
    )?.fundingSource;
    return (
      fundingSource === "WALLET" ||
      fundingSource === "INVOICE" ||
      fundingSource === "LICENSE"
    );
  }, [organizationId, session?.user?.organizationMemberships]);
  const required = !isInternational && !orgFunded;

  const onChange = useCallback((stateCode: string | null) => {
    setAnswered(true);
    setValue(stateCode);
  }, []);

  const validate = useCallback(() => {
    const ok = !required || value !== null;
    setSubmitBlocked(!ok);
    // The field sits in the other column from the pay button; focus brings its error into view.
    if (!ok) document.getElementById("billing-state")?.focus();
    return ok;
  }, [required, value]);

  const bodyField = useMemo(
    () => (value ? { consumerStateCode: value } : {}),
    [value],
  );

  const error =
    submitBlocked && required && value === null
      ? BUYER_STATE_REQUIRED_MESSAGE
      : null;
  const selectProps = useMemo(
    () => ({ value, onChange, required, error }),
    [value, onChange, required, error],
  );

  return { selectProps, validate, bodyField };
}
