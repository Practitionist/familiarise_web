import { LibraryPage } from "@/components/dashboard/library/LibraryPage";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import prisma from "@/lib/prisma";

/** Library › Purchases | Session recordings | Session documents. */
export default async function ConsulteeLibraryRoute({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { consulteeId } = await params;
  const access = await requirePersonalProfileAccess("consultee", consulteeId);
  // An inspecting operator reads the profile owner's purchases, not their own.
  const buyerId = access.isInspecting
    ? ((
        await prisma.consulteeProfile.findUnique({
          where: { id: consulteeId },
          select: { userId: true },
        })
      )?.userId ?? null)
    : access.userId;
  return (
    <LibraryPage
      title="Library"
      basePath={`/dashboard/consultee/${consulteeId}/library`}
      tabs={["purchases", "recordings", "documents"]}
      owner={{
        kind: "personal",
        buyerId,
        learner: {
          consulteeId,
          readerId: access.userId,
          skipSeed: access.isInspecting,
        },
      }}
      searchParams={await searchParams}
    />
  );
}
