import { requireNotOnboarded } from "@/lib/auth-guard";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireNotOnboarded();
  return <>{children}</>;
}
