import { requireBackofficePage } from "@/lib/auth-guard";
import { TeamPageClient } from "./TeamPageClient";

/**
 * #1927 — the operator roster, at `/dashboard/{admin,staff}/team`.
 *
 * ## Why here and not under `/dashboard/admin/users`
 *
 * The `users` page is the *whole platform's* directory — 400+ consultees and
 * consultants, paginated, with User 360 drill-down. This page is the
 * twenty-person list of people who can reach the console, and the actions
 * that change their access (add staff, reset 2FA).
 *
 * ## Why both trees
 *
 * `[tree]` is the merged back-office tree (#1527): the same page renders at
 * `/dashboard/admin/team` and `/dashboard/staff/team`, and the AUDIENCE is
 * chosen by the tree. Staff may open it — `team.read` is an operator surface,
 * and "who else is on staff" is a normal support question — but every action
 * is hidden for them, because `users.moderate` is admin-only and the client
 * asks the same matrix the API enforces. A button a staff member can see and
 * cannot press is a support ticket.
 */
export default async function BackofficeTeamPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level gate. Required on its own: `lib/auth-guard.ts:206-208` — the
  // layout does NOT re-run on client navigation, and the sidebar hiding a link
  // is not access control.
  await requireBackofficePage("team.read", (await params).tree);
  return <TeamPageClient />;
}
