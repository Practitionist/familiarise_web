import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";

/**
 * The viewer's ACTIVE org memberships as `{ orgId: orgName }`, driving the
 * "Recommended by <org>" badge on program cards (#664).
 *
 * This lives behind a client fetch (not the programs page render) so
 * `/explore/programs` stays a cacheable ISR route: identity-dependent UI
 * belongs in a client-only resolution, never in the shared server render.
 * Signed-out returns `{}` without touching the database — that is an answer,
 * not a failure.
 */
export async function GET() {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ orgs: {} });

  const memberships = await prisma.membership.findMany({
    where: { userId, status: "ACTIVE" },
    select: { organization: { select: { id: true, name: true } } },
  });
  return NextResponse.json({
    orgs: Object.fromEntries(
      memberships.map((m) => [m.organization.id, m.organization.name]),
    ),
  });
}
