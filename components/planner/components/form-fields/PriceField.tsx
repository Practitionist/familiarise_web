"use client";

import {
  Control,
  FieldPath,
  FieldValues,
  useController,
} from "react-hook-form";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
  RequiredMark,
} from "@/components/ui/form";
import { cn } from "@/utils/tailwind";

// INR only. The platform settles in INR end to end — Razorpay always settles
// INR (gateway-router.ts) and the double-entry ledger is INR-denominated (#783)
// — so a plan priced in another currency is either rejected at checkout or, via
// the request→approve path, charged for real and then booked as if the number
// were rupees. Offering the choice here was the only way to create that state.
// Restore the other values only alongside genuine multi-currency settlement.
const DEFAULT_CURRENCIES = ["INR"];

interface PriceFieldProps<T extends FieldValues = FieldValues> {
  control: Control<T>;
  priceName: string;
  currencyName: string;
  label?: string;
  description?: string;
  currencies?: string[];
  className?: string;
  /** Required to publish — appends `*` to the label. */
  required?: boolean;
}

export function PriceField<T extends FieldValues = FieldValues>({
  control,
  priceName,
  currencyName,
  label = "Price (₹)",
  description,
  currencies = DEFAULT_CURRENCIES,
  className,
  required,
}: Readonly<PriceFieldProps<T>>) {
  const {
    field: priceField,
    fieldState: { error: priceError },
  } = useController({
    name: priceName as FieldPath<T>,
    control,
    defaultValue: 0 as T[string],
  });

  const {
    field: currencyField,
    fieldState: { error: currencyError },
  } = useController({
    name: currencyName as FieldPath<T>,
    control,
    defaultValue: "INR" as T[string],
  });

  const error = priceError || currencyError;
  const priceId = useId();

  return (
    <FormItem className={className}>
      <FormLabel htmlFor={priceId}>
        {label}
        {required && <RequiredMark />}
      </FormLabel>
      {description && (
        <FormDescription id={`${priceId}-description`}>
          {description}
        </FormDescription>
      )}

      <div className="flex gap-2 rounded-2xl border border-border bg-muted/40 p-2">
        <Select
          value={currencyField.value}
          onValueChange={currencyField.onChange}
        >
          <SelectTrigger
            className="h-11 w-[90px] rounded-xl bg-background"
            aria-label="Price currency"
          >
            <SelectValue placeholder="Currency" />
          </SelectTrigger>
          <SelectContent>
            {currencies.map((currency) => (
              <SelectItem key={currency} value={currency}>
                {currency}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          id={priceId}
          name={priceField.name}
          ref={priceField.ref}
          onBlur={priceField.onBlur}
          aria-invalid={!!priceError}
          aria-describedby={
            [
              description ? `${priceId}-description` : "",
              error ? `${priceId}-error` : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
          type="number"
          min="0"
          max={99999999}
          placeholder="0"
          className={cn(
            "h-11 min-w-0 flex-1 rounded-xl bg-background",
            error && "border-destructive",
          )}
          value={priceField.value}
          onChange={(e) => {
            const value = e.target.value;
            priceField.onChange(value === "" ? 0 : Number.parseFloat(value));
          }}
        />
      </div>

      {error && (
        <FormMessage id={`${priceId}-error`}>{error.message}</FormMessage>
      )}
    </FormItem>
  );
}
