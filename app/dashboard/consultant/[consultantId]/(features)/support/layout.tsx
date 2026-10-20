import { HelpSupportLayout } from "@/components/dashboard/shared/support/HelpSupportLayout";
import { notFound } from "next/navigation";
import { requireOnboarded } from "@/lib/auth-guard";
export default async function HelpLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ consultantId: string }>;
}>) {
  const { consultantId } = await params;
  const { user } = await requireOnboarded();
  if (
    user.consultantProfileId !== consultantId &&
    user.role !== "ADMIN" &&
    user.role !== "STAFF"
  )
    notFound();
  return (
    <HelpSupportLayout basePath={`/dashboard/consultant/${consultantId}`}>
      {children}
    </HelpSupportLayout>
  );
}
