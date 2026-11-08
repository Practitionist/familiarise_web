import { BuyerPriceProvider } from "@/components/pricing/BuyerPriceProvider";
import { isPlatformGstRegistered } from "@/lib/pdf/supplier";

export default function ExploreLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <BuyerPriceProvider gstRegistered={isPlatformGstRegistered()}>
      {children}
    </BuyerPriceProvider>
  );
}
