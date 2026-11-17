import type { CollaboratorStatus } from "@prisma/client";
import type { Metadata } from "next";
import Link from "next/link";

import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireBackofficePage } from "@/lib/auth-guard";
import { can } from "@/lib/backoffice/capability";
import {
  COLLABORATIONS_PAGE_SIZE,
  readCollaborations,
} from "@/lib/backoffice/collaborations-read";
import { pageNumberSchema } from "@/lib/backoffice/list-paging";
import { OperatorTimeStack } from "@/lib/time/operator-time";
import type { Tone } from "@/lib/ui/tone";

export const metadata: Metadata = { title: "Collaborations — Familiarise" };

const STATUS: Record<CollaboratorStatus, { label: string; tone: Tone }> = {
  PENDING: { label: "Invited", tone: "info" },
  ACCEPTED: { label: "On the team", tone: "success" },
  DECLINED: { label: "Declined", tone: "neutral" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  WITHDRAWN: { label: "Left", tone: "neutral" },
  REMOVED: { label: "Removed", tone: "caution" },
};

/** Read-only list of every collaboration, for the operators who read payouts. */
export default async function BackofficeCollaborationsPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ tree: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { cap } = await requireBackofficePage(
    "payouts.read",
    (await params).tree,
  );
  const page = pageNumberSchema.parse((await searchParams).page);
  const { rows, total } = await readCollaborations({ page });
  const pages = Math.max(1, Math.ceil(total / COLLABORATIONS_PAGE_SIZE));
  const here = `${cap.basePath}/collaborations`;
  // Holding an earning is an admin door; staff read the list without the link.
  const holdsHref = can(cap, "payouts.manage")
    ? `${cap.basePath}/money/earnings`
    : null;

  return (
    <>
      <PageHeader
        title="Collaborations"
        description="Every invitation and team place on a webinar or class plan, the most recently changed first. Nothing can be changed here."
      />
      <DashboardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead>
              <TableHead>Expert</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Share</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Accepted</TableHead>
              <TableHead>Ended</TableHead>
              <TableHead>Ended by</TableHead>
              {holdsHref ? <TableHead>Earnings</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={holdsHref ? 9 : 8}
                  className="text-muted-foreground"
                >
                  No collaborations on this page.
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <div className="font-medium">{row.planTitle}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.planType === "webinar" ? "Webinar" : "Class"}
                    {row.organizationName ? ` · ${row.organizationName}` : ""}
                  </div>
                </TableCell>
                <TableCell>
                  <PersonCell person={row.expert} />
                </TableCell>
                <TableCell>{row.roleLabel}</TableCell>
                <TableCell>{row.sharePercent}%</TableCell>
                <TableCell>
                  <StatusBadge {...STATUS[row.status]} />
                </TableCell>
                <TableCell>
                  <OperatorTimeStack value={row.acceptedAt} />
                </TableCell>
                <TableCell>
                  <OperatorTimeStack value={row.endedAt} />
                </TableCell>
                <TableCell>
                  {row.endedBy ? (
                    <PersonCell person={row.endedBy} />
                  ) : row.endedAt ? (
                    "The platform"
                  ) : (
                    "—"
                  )}
                </TableCell>
                {holdsHref ? (
                  <TableCell>
                    <Link href={holdsHref} className="underline">
                      Earnings holds
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {row.consultantProfileId}
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <nav
          aria-label="Pages"
          className="mt-4 flex items-center justify-between text-sm"
        >
          <span className="text-muted-foreground">
            Page {page} of {pages} · {total} in all
          </span>
          <span className="flex gap-4">
            {page > 1 ? (
              <Link href={`${here}?page=${page - 1}`} className="underline">
                Previous
              </Link>
            ) : null}
            {page < pages ? (
              <Link href={`${here}?page=${page + 1}`} className="underline">
                Next
              </Link>
            ) : null}
          </span>
        </nav>
      </DashboardContent>
    </>
  );
}
