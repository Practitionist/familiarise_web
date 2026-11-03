import { LibraryPage } from "@/components/dashboard/library/LibraryPage";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import prisma from "@/lib/prisma";

/**
 * My library: the expert as a buyer. Attended sessions live on the learner
 * side, so their tabs appear only when the owner also holds a learner profile.
 */
export default async function ConsultantLibraryRoute({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { consultantId } = await params;
  const access = await requirePersonalProfileAccess("consultant", consultantId);
  const owner = await prisma.consultantProfile.findUnique({
    where: { id: consultantId },
    select: { userId: true, user: { select: { consulteeProfileId: true } } },
  });
  const consulteeId = owner?.user.consulteeProfileId ?? null;
  return (
    <LibraryPage
      title="My library"
      basePath={`/dashboard/consultant/${consultantId}/library`}
      tabs={
        consulteeId ? ["purchases", "recordings", "documents"] : ["purchases"]
      }
      owner={{
        kind: "personal",
        buyerId: owner?.userId ?? null,
        learner: consulteeId
          ? {
              consulteeId,
              readerId: access.userId,
              skipSeed: access.isInspecting,
            }
          : null,
      }}
      searchParams={await searchParams}
    />
  );
}
