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
  type BackofficeCollaboration,
} from "@/lib/backoffice/collaborations-read";
import { pageNumberSchema } from "@/lib/backoffice/list-paging";
import type { PersonLike } from "@/lib/backoffice/person";
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

/**
 * A person by name and email, linked to their back-office page. Someone with
 * neither keeps a muted id, so two such rows can be told apart.
 */
function PersonLink({
  person,
  basePath,
}: Readonly<{ person: PersonLike; basePath: string }>) {
  const named = Boolean(person.name?.trim() || person.email?.trim());
  const cell = <PersonCell person={named ? { ...person, id: null } : person} />;
  if (!person.id) return cell;
  return (
    <Link
      href={`${basePath}/users/${person.id}`}
      className="block rounded hover:underline"
    >
      {cell}
    </Link>
  );
}

/** Who ended a collaboration: a person, the platform, or nobody yet. */
function EndedBy({
  row,
  basePath,
}: Readonly<{ row: BackofficeCollaboration; basePath: string }>) {
  if (row.endedBy) {
    return <PersonLink person={row.endedBy} basePath={basePath} />;
  }
  return <>{row.endedAt ? "The platform" : "—"}</>;
}

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
                  <PersonLink person={row.expert} basePath={cap.basePath} />
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
                  <EndedBy row={row} basePath={cap.basePath} />
                </TableCell>
                {holdsHref ? (
                  <TableCell>
                    <Link
                      href={`${holdsHref}?consultantProfileId=${encodeURIComponent(row.consultantProfileId)}`}
                      className="underline"
                    >
                      Earnings holds
                    </Link>
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
