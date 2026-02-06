import { requireAuth } from "@/lib/auth-guard";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAuth();
  return <>{children}</>;
}
