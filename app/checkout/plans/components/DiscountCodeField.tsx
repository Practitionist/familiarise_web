"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { FieldError, invalidProps } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { ErrorTypes } from "@/lib/errors/classification/payment-error-classification";
import type { CheckoutInput } from "@/schemas/checkout";
import type { AppliedDiscount } from "@/types/checkout";

import { appliedDiscountLabel } from "../math";

const ERROR_ID = "discount-code-error";

/** Error type or code strings a refused discount code arrives as at pay time. */
const DISCOUNT_REFUSALS: ReadonlySet<string> = new Set([
  ErrorTypes.DISCOUNT_CODE_INVALID,
  ErrorTypes.DISCOUNT_EXHAUSTED,
  ErrorTypes.DISCOUNT_NOT_APPLICABLE,
  ErrorTypes.DISCOUNT_CURRENCY_MISMATCH,
  "DISCOUNT_EXHAUSTED",
  "DISCOUNT_NOT_APPLICABLE",
  "DISCOUNT_CODE_INVALID",
]);

/** True when a checkout refusal is about the discount code rather than the payment. */
export function isDiscountRefusal(refusal: {
  errorType?: string;
  code?: string;
}): boolean {
  return (
    (refusal.errorType !== undefined &&
      DISCOUNT_REFUSALS.has(refusal.errorType)) ||
    (refusal.code !== undefined && DISCOUNT_REFUSALS.has(refusal.code))
  );
}

interface ValidateResponse {
  valid?: boolean;
  code?: string;
  discountType?: AppliedDiscount["discountType"];
  discountValue?: number;
  discountAmount?: number;
  message?: string;
}

/** The discount code state of one checkout page: the input, the applied code and its inline error. */
export function useDiscountCode(params: {
  amountPaise: number;
  consultantProfileId: string | undefined;
  /** The item being bought; the buyer's own open order for it does not use up the code. */
  checkout?: CheckoutInput | null;
}) {
  const { amountPaise, consultantProfileId, checkout } = params;
  const [input, setInputValue] = useState("");
  const [applied, setApplied] = useState<AppliedDiscount | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An error stays until the buyer edits the code.
  const setInput = useCallback((value: string) => {
    setInputValue(value.toUpperCase());
    setError(null);
  }, []);

  const apply = useCallback(async () => {
    if (!input.trim()) {
      setError("Please enter a discount code");
      return;
    }
    setIsApplying(true);
    setError(null);
    try {
      const response = await fetch("/api/payments/discounts/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: input,
          amount: amountPaise,
          consultantProfileId,
          ...(checkout ? { checkout } : {}),
        }),
      });
      const data: ValidateResponse = await response.json();
      if (data.valid && data.code && data.discountType) {
        setApplied({
          code: data.code,
          discountType: data.discountType,
          discountValue: data.discountValue ?? 0,
          discountAmount: data.discountAmount,
        });
        setInputValue("");
      } else {
        setError(data.message || "Invalid discount code");
      }
    } catch {
      setError("Failed to validate discount code");
    } finally {
      setIsApplying(false);
    }
  }, [input, amountPaise, consultantProfileId, checkout]);

  const remove = useCallback(() => {
    setApplied(null);
    setError(null);
  }, []);

  /** A code checkout refused at pay time: drop it and say why, in the field. */
  const refuse = useCallback((message: string, code?: string) => {
    setApplied(null);
    if (code) setInputValue(code);
    setError(message);
  }, []);

  return {
    input,
    setInput,
    applied,
    isApplying,
    error,
    apply,
    remove,
    refuse,
  };
}

export type DiscountCodeState = ReturnType<typeof useDiscountCode>;

/** The discount code input, its Apply button, the applied chip and the inline error. */
export function DiscountCodeField({
  discount,
  formatPrice,
  listPricePaise,
}: Readonly<{
  discount: DiscountCodeState;
  formatPrice: (paise: number) => string;
  /** The list price, so a percentage code capped below its face value says so. */
  listPricePaise?: number;
}>) {
  const { applied, error } = discount;
  const label = applied
    ? appliedDiscountLabel(applied, formatPrice, listPricePaise)
    : null;
  return (
    <div className="grid gap-4">
      <label htmlFor="discount-code-input" className="font-semibold">
        Discount Codes
      </label>
      <div className="flex items-center gap-2">
        <Input
          id="discount-code-input"
          type="text"
          placeholder="Enter discount code"
          className="flex-1"
          value={discount.input}
          onChange={(e) => discount.setInput(e.target.value)}
          disabled={discount.isApplying || applied !== null}
          {...invalidProps(error, ERROR_ID)}
        />
        <Button
          variant="outline"
          onClick={() => void discount.apply()}
          disabled={
            discount.isApplying || applied !== null || !discount.input.trim()
          }
        >
          {discount.isApplying ? "Applying..." : "Apply"}
        </Button>
      </div>
      <FieldError id={ERROR_ID} message={error} />
      {applied && label && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 p-3">
          <div className="min-w-0">
            <div className="truncate font-medium text-green-700">
              {applied.code}
            </div>
            <div className="text-sm text-green-600">
              {label.label}
              {label.limited && (
                <span className="block text-xs">
                  Limited to the most this booking allows.
                </span>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-green-700 hover:text-green-800"
            onClick={discount.remove}
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}
