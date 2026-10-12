import { NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";

const Params = z.object({ appointmentId: z.string().min(1) });

/** A booking's live document threads for support: titles, sides and removal requests. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const auth = await requireBackofficeSurface("appointments.manage");
  if (auth.error) return auth.error;
  const parsed = Params.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid appointment id" },
      { status: 400 },
    );
  }
  const roots = await prisma.appointmentDocument.findMany({
    where: {
      appointmentId: parsed.data.appointmentId,
      rootDocumentId: null,
      deletedAt: null,
    },
    orderBy: [
      { removalRequestedAt: { sort: "desc", nulls: "last" } },
      { uploadedAt: "desc" },
    ],
    select: {
      id: true,
      originalName: true,
      uploadedByRole: true,
      uploadedAt: true,
      removalRequestedAt: true,
      _count: { select: { threadVersions: { where: { deletedAt: null } } } },
    },
  });
  return NextResponse.json(
    {
      threads: roots.map((r) => ({
        rootId: r.id,
        title: r.originalName,
        uploadedBy: r.uploadedByRole === "CONSULTANT" ? "expert" : "learner",
        uploadedAt: r.uploadedAt.toISOString(),
        versions: r._count.threadVersions + 1,
        removalRequestedAt: r.removalRequestedAt?.toISOString() ?? null,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
