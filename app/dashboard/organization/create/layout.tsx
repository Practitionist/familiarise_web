import { requireUserRole } from "@/lib/auth-guard";

export default async function CreateOrganizationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUserRole("ORG_ADMIN");
  return <>{children}</>;
}
