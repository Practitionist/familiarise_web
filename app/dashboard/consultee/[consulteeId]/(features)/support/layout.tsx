import { HelpSupportLayout } from "@/components/dashboard/shared/support/HelpSupportLayout";
import { notFound } from "next/navigation";
import { requireOnboarded } from "@/lib/auth-guard";
export default async function HelpLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ consulteeId: string }>;
}>) {
  const { consulteeId } = await params;
  const { user } = await requireOnboarded();
  if (
    user.consulteeProfileId !== consulteeId &&
    user.role !== "ADMIN" &&
    user.role !== "STAFF"
  )
    notFound();
  return (
    <HelpSupportLayout basePath={`/dashboard/consultee/${consulteeId}`}>
      {children}
    </HelpSupportLayout>
  );
}
