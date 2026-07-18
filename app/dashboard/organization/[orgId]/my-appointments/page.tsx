/**
 * /dashboard/organization/[orgId]/my-appointments — the member's own per-org
 * appointments (#org-appts).
 *
 * Access: ANY active member. Both learners who ATTEND org-sponsored sessions
 * and experts who DELIVER them get this surface — deliberately NOT gated on
 * canHost (that would exclude pure learners). requireOrgAccess already floors
 * access at an ACTIVE membership; a non-member falls through to notFound().
 *
 * SSR-renders the list directly (getOrgMemberAppointments in the RSC, items
 * handed to the client as props) rather than prefetch+hydrate: there is no
 * MANAGER-open API route for orgMember scope to fetch from, so a direct read
 * is the lighter, waterfall-free path. Pagination re-renders the RSC via a
 * ?page= link.
 *
 * StreamProvider (video-only) wraps ONLY the client subtree so the lazy Join
 * has a connected video client — the org dashboard layout mounts no
 * StreamProvider, and we don't want to connect video on every org page.
 */

import { notFound } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { getOrgMemberAppointments } from "@/lib/data/org-appointments";
import StreamProvider from "@/providers/StreamProvider";
import {
  MyAppointmentsClient,
  type MyAppointmentItem,
} from "./MyAppointmentsClient";

export default async function MyAppointmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;

  const access = await requireOrgAccess(orgId);
  // requireOrgAccess returns an error for non-members / inactive memberships;
  // keep the URL tree honest with a 404 rather than leaking the shell.
  if (access.error) {
    notFound();
  }

  const rawPage = Number(sp.page ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  const userId = access.session.user.id;
  const { items, total, perPage } = await getOrgMemberAppointments(
    orgId,
    userId,
    { page },
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">My Appointments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sessions you&apos;re attending or delivering under {access.org.name}.
        </p>
      </header>

      {/* Video-only Stream client, scoped to this page so the Join button has a
          connected client without connecting video on every org route. */}
      <StreamProvider userId={userId} enableChat={false} enableVideo={true}>
        <MyAppointmentsClient
          orgId={orgId}
          viewerId={userId}
          items={items as unknown as MyAppointmentItem[]}
          total={total}
          page={page}
          perPage={perPage}
        />
      </StreamProvider>
    </div>
  );
}
