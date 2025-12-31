"use client";

import { Control, useController } from "react-hook-form";
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
} from "@/components/ui/form";
import { cn } from "@/lib/utils";

const DEFAULT_CURRENCIES = ["INR", "USD", "EUR", "GBP"];

interface PriceFieldProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: Control<any>;
  priceName: string;
  currencyName: string;
  label?: string;
  description?: string;
  currencies?: string[];
  className?: string;
}

export function PriceField({
  control,
  priceName,
  currencyName,
  label = "Price",
  description,
  currencies = DEFAULT_CURRENCIES,
  className,
}: Readonly<PriceFieldProps>) {
  const {
    field: priceField,
    fieldState: { error: priceError },
  } = useController({
    name: priceName,
    control,
    defaultValue: 0,
  });

  const {
    field: currencyField,
    fieldState: { error: currencyError },
  } = useController({
    name: currencyName,
    control,
    defaultValue: "INR",
  });

  const error = priceError || currencyError;

  return (
    <FormItem className={className}>
      <FormLabel>{label}</FormLabel>
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
          placeholder="0"
          className={cn("flex-1", error && "border-destructive")}
          value={priceField.value}
          onChange={(e) => {
            const value = e.target.value;
            priceField.onChange(value === "" ? 0 : Number.parseFloat(value));
          }}
        />
      </div>

      {error && <FormMessage>{error.message}</FormMessage>}
    </FormItem>
  );
}
