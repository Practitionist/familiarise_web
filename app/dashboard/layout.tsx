import { requireOnboarded } from "@/lib/auth-guard";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOnboarded();
  return <>{children}</>;
}
