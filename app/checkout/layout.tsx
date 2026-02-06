import { requireOnboarded } from "@/lib/auth-guard";

export default async function CheckoutLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOnboarded();
  return <>{children}</>;
}
