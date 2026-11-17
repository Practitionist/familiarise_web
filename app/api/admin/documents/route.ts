/**
 * GET /api/admin/documents
 *
 * Platform-wide AppointmentDocument list for the back-office. Read-only.
 *
 * Support had no way to see documents at all: a ticket about a rejected
 * upload ("why was my document turned down?") could not be investigated
 * without asking the consultant directly. This surfaces the document, its
 * review status, the reviewer's notes, and which appointment it belongs to.
 *
 * Deliberately read-only. Reviewing is the consultant's judgement call about
 * their own session, not an operator's, so there is no PATCH here — the
 * back-office observes the review, it does not perform it.
 *
 * `users.verify` (ADMIN or STAFF): the list is a tab of the Verification page,
 * and documents are support context.
 */

import { fileApiError } from "@/lib/documents/api-error";
import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { listDocumentsScoped } from "@/lib/api/scope/list-documents";
import { parsePagination } from "@/lib/enterprise/validators";

const QuerySchema = z.object({
  reviewStatus: z
    .enum(["PENDING", "APPROVED", "REJECTED", "IN_REVIEW", "NEEDS_REVISION"])
    .optional(),
});

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("users.verify");
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const filters = QuerySchema.safeParse({
    reviewStatus: url.searchParams.get("reviewStatus") ?? undefined,
  });
  if (!filters.success) return fileApiError("INVALID_INPUT");

  const pagination = parsePagination(url);

  try {
    // `all` scope applies no ownership filter: the platform-wide view the gate above admits.
    const result = await listDocumentsScoped({
      scope: { kind: "all" },
      userId: auth.session.user.id,
      reviewStatus: filters.data.reviewStatus,
      page: pagination.page,
      perPage: pagination.pageSize,
    });

    return NextResponse.json(result);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    return fileApiError("SERVER_ERROR");
  }
}
