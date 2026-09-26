import { requireOnboarded } from "@/lib/auth-guard";
import { ENABLE_CHECKOUT_EMI } from "@/lib/feature-flags";
import { CheckoutFlagsProvider } from "./components/CheckoutFlags";

export default async function CheckoutLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOnboarded();
  return (
    <CheckoutFlagsProvider emiEnabled={ENABLE_CHECKOUT_EMI}>
      {children}
    </CheckoutFlagsProvider>
  );
}
