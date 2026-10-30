import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { DigitalProductLibrary } from "@/components/dashboard/library/DigitalProductLibrary";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { readDigitalProductLibrary } from "@/lib/data/digital-product-library";
import prisma from "@/lib/prisma";

export default async function ConsulteeDigitalProductsRoute({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  const access = await requirePersonalProfileAccess("consultee", consulteeId);
  // An inspecting operator reads the profile owner's library, not their own.
  const ownerId = access.isInspecting
    ? (
        await prisma.consulteeProfile.findUnique({
          where: { id: consulteeId },
          select: { userId: true },
        })
      )?.userId
    : access.userId;
  const products = ownerId ? await readDigitalProductLibrary(ownerId) : [];
  return (
    <>
      <DashboardHeader
        title="Digital products"
        description="Files you bought or claimed. Downloads never expire, and you always get the latest version."
      />
      <DashboardContent>
        <DigitalProductLibrary products={products} />
      </DashboardContent>
    </>
  );
}
