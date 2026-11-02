import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { DigitalProductLibrary } from "@/components/dashboard/library/DigitalProductLibrary";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { readDigitalProductLibrary } from "@/lib/data/digital-product-library";
import prisma from "@/lib/prisma";

/** Digital products this expert bought from other experts, keyed by user, not learner profile. */
export default async function ConsultantPurchasesRoute({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  const access = await requirePersonalProfileAccess("consultant", consultantId);
  // An inspecting operator reads the profile owner's purchases, not their own.
  const ownerId = access.isInspecting
    ? (
        await prisma.consultantProfile.findUnique({
          where: { id: consultantId },
          select: { userId: true },
        })
      )?.userId
    : access.userId;
  const products = ownerId ? await readDigitalProductLibrary(ownerId) : [];
  return (
    <>
      <DashboardHeader
        title="My purchases"
        description="Digital products you bought or claimed from other experts. Downloads never expire, and you always get the latest version."
      />
      <DashboardContent>
        <DigitalProductLibrary products={products} />
      </DashboardContent>
    </>
  );
}
