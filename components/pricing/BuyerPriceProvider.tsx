"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { useCurrency } from "@/hooks/useCurrency";
import {
  buyerDisplayPricePaise,
  buyerPriceNote,
  withBuyerPriceNote,
} from "@/lib/payments/pricing/display-price";
import { cn } from "@/utils/tailwind";

/**
 * Whether buyer prices are shown all-in. The server decides from
 * PLATFORM_GSTIN and passes it in; the default keeps list prices if the
 * provider is ever missing.
 */
const BuyerPriceContext = createContext<boolean>(false);

export function BuyerPriceProvider({
  gstRegistered,
  children,
}: Readonly<{ gstRegistered: boolean; children: React.ReactNode }>) {
  return (
    <BuyerPriceContext.Provider value={gstRegistered}>
      {children}
    </BuyerPriceContext.Provider>
  );
}

/** Formats a plan's list price (INR paise) the way a buyer should see it. */
export function useBuyerPrice() {
  const gstRegistered = useContext(BuyerPriceContext);
  const { formatPrice } = useCurrency();
  const formatBuyerPrice = useCallback(
    (listPricePaise: number) =>
      formatPrice(buyerDisplayPricePaise(listPricePaise, gstRegistered)),
    [formatPrice, gstRegistered],
  );
  const formatBuyerPriceLabel = useCallback(
    (listPricePaise: number) =>
      withBuyerPriceNote(
        formatBuyerPrice(listPricePaise),
        listPricePaise,
        gstRegistered,
      ),
    [formatBuyerPrice, gstRegistered],
  );
  const noteFor = useCallback(
    (listPricePaise: number) => buyerPriceNote(listPricePaise, gstRegistered),
    [gstRegistered],
  );
  return useMemo(
    () => ({ gstRegistered, formatBuyerPrice, formatBuyerPriceLabel, noteFor }),
    [gstRegistered, formatBuyerPrice, formatBuyerPriceLabel, noteFor],
  );
}

/** A buyer price with its "incl. GST" note once the platform is registered. */
export function BuyerPrice({
  paise,
  noteClassName,
}: Readonly<{ paise: number; noteClassName?: string }>) {
  const { formatBuyerPrice, noteFor } = useBuyerPrice();
  const note = noteFor(paise);
  return (
    <>
      {formatBuyerPrice(paise)}
      {note && (
        <span
          className={cn(
            "ml-1.5 text-xs font-normal text-muted-foreground",
            noteClassName,
          )}
        >
          {note}
        </span>
      )}
    </>
  );
}
