"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { CURRENCY_LOCALE_MAP } from "@/utils/formatting";

const STORAGE_KEY = "preferred-currency";
const DEFAULT_CURRENCY = "INR";

// Currencies offered in the navbar dropdown (keep this list lean)
export const SUPPORTED_CURRENCIES = [
  { code: "INR", symbol: "\u20B9", label: "INR (\u20B9)" },
  { code: "USD", symbol: "$", label: "USD ($)" },
  { code: "EUR", symbol: "\u20AC", label: "EUR (\u20AC)" },
  { code: "GBP", symbol: "\u00A3", label: "GBP (\u00A3)" },
  { code: "AUD", symbol: "A$", label: "AUD (A$)" },
  { code: "CAD", symbol: "C$", label: "CAD (C$)" },
  { code: "SGD", symbol: "S$", label: "SGD (S$)" },
  { code: "AED", symbol: "AED", label: "AED" },
  { code: "JPY", symbol: "\u00A5", label: "JPY (\u00A5)" },
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number]["code"];

// ---------- shared external store (cross-component reactivity) ----------

let listeners: (() => void)[] = [];

function emitChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot(): string {
  if (typeof window === "undefined") return DEFAULT_CURRENCY;
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_CURRENCY;
}

function getServerSnapshot(): string {
  return DEFAULT_CURRENCY;
}

// ---------- public setter (used by navbar dropdown) ----------

export function setPreferredCurrency(code: string) {
  localStorage.setItem(STORAGE_KEY, code);
  emitChange();
}

// ---------- hook ----------

interface CurrencyData {
  rate: number;
  currency: string;
  symbol: string;
}

export function useCurrency() {
  const queryClient = useQueryClient();
  const selectedCurrency = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const isINR = selectedCurrency === "INR";

  const { data, isLoading } = useQuery<CurrencyData>({
    queryKey: ["currency-rate", selectedCurrency],
    queryFn: async () => {
      const res = await fetch(
        `/api/currency?to=${encodeURIComponent(selectedCurrency)}`,
      );
      if (!res.ok) throw new Error("Failed to fetch currency rate");
      return res.json();
    },
    enabled: !isINR,
    staleTime: 60 * 60 * 1000, // 1 hour
    gcTime: 2 * 60 * 60 * 1000,
    retry: 2,
  });

  const currency = isINR ? "INR" : (data?.currency ?? selectedCurrency);
  const symbol = isINR
    ? "\u20B9"
    : (data?.symbol ??
      SUPPORTED_CURRENCIES.find((c) => c.code === selectedCurrency)?.symbol ??
      selectedCurrency);
  const rate = isINR ? 1 : (data?.rate ?? 1);

  const convert = useCallback(
    (amountINR: number): number => {
      if (isINR) return amountINR;
      return Math.round(amountINR * rate * 100) / 100;
    },
    [rate, isINR],
  );

  const formatPrice = useCallback(
    (amountInPaise: number): string => {
      // Convert from paise (smallest unit) to major unit for display
      const amountInMajor = amountInPaise / 100;
      const converted = convert(amountInMajor);
      // Use currency-appropriate locale for correct grouping (e.g. ₹1,00,000 vs $100,000)
      const locale =
        CURRENCY_LOCALE_MAP[currency.toUpperCase()] ||
        (typeof navigator !== "undefined" ? navigator.language : "en-IN");
      try {
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        }).format(converted);
      } catch {
        return `${symbol}${Math.round(converted).toLocaleString()}`;
      }
    },
    [convert, currency, symbol],
  );

  const setCurrency = useCallback(
    (code: string) => {
      setPreferredCurrency(code);
      // Invalidate so a new fetch fires if needed
      queryClient.invalidateQueries({ queryKey: ["currency-rate"] });
    },
    [queryClient],
  );

  return {
    currency,
    symbol,
    rate,
    convert,
    formatPrice,
    setCurrency,
    isLoading: !isINR && isLoading,
  };
}
