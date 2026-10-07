"use client";

import { usePathname } from "next/navigation";
import {
  Control,
  FieldPath,
  FieldValues,
  useController,
} from "react-hook-form";
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
  feeSchedule?: {
    marketplaceBps: number;
    ownLinkBps: number;
  };
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
  feeSchedule,
}: Readonly<PriceFieldProps<T>>) {
  const pathname = usePathname();
  const isOrgCatalog =
    pathname?.startsWith("/dashboard/organization/") ?? false;
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
  const numericPrice = Number(priceField.value);
  const currencyCode = String(currencyField.value || "INR");

  return (
    <FormItem className={className}>
      <FormLabel>
        {label}
        {required && <RequiredMark />}
      </FormLabel>
      {description && <FormDescription>{description}</FormDescription>}

      <div className="flex gap-2">
        <Select
          value={currencyField.value}
          onValueChange={currencyField.onChange}
        >
          <SelectTrigger className="w-[90px]">
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
          type="number"
          min="0"
          max={99999999}
          placeholder="0"
          className={cn("flex-1", error && "border-destructive")}
          value={priceField.value}
          onChange={(e) => {
            const value = e.target.value;
            priceField.onChange(value === "" ? 0 : Number.parseFloat(value));
          }}
        />
      </div>

      {!isOrgCatalog && (
        <p className="text-xs text-muted-foreground">
          {feeSchedule
            ? numericPrice > 0
              ? `You keep ${formatProceeds((numericPrice * (10_000 - feeSchedule.marketplaceBps)) / 10_000, currencyCode)} on Marketplace · ${formatProceeds((numericPrice * (10_000 - feeSchedule.ownLinkBps)) / 10_000, currencyCode)} via your personal link (?via=, before TDS)`
              : `Marketplace fee ${(feeSchedule.marketplaceBps / 100).toFixed(feeSchedule.marketplaceBps % 100 === 0 ? 0 : 2)}% · Personal link (?via=) fee ${(feeSchedule.ownLinkBps / 100).toFixed(feeSchedule.ownLinkBps % 100 === 0 ? 0 : 2)}% (before TDS)`
            : "Platform fee follows the active schedule (reduced own-link rate when a buyer first discovers you via ?via=, before TDS)."}
        </p>
      )}

      {error && <FormMessage>{error.message}</FormMessage>}
    </FormItem>
  );
}

function formatProceeds(amountMajor: number, currency: string): string {
  const rounded = Math.round(amountMajor);
  const code = currency || "INR";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }).format(rounded);
  } catch {
    return `${code} ${rounded.toLocaleString("en-IN")}`;
  }
}
