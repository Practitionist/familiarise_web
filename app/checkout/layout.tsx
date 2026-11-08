import { requireOnboarded } from "@/lib/auth-guard";
import { ENABLE_CHECKOUT_EMI } from "@/lib/feature-flags";
import { BuyerPriceProvider } from "@/components/pricing/BuyerPriceProvider";
import { isPlatformGstRegistered } from "@/lib/pdf/supplier";
import { CheckoutFlagsProvider } from "./components/CheckoutFlags";

export default async function CheckoutLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOnboarded();
  return (
    <BuyerPriceProvider gstRegistered={isPlatformGstRegistered()}>
      <CheckoutFlagsProvider emiEnabled={ENABLE_CHECKOUT_EMI}>
        {children}
      </CheckoutFlagsProvider>
    </BuyerPriceProvider>
  );
}
