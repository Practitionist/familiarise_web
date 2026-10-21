import prisma from "@/lib/prisma";
import { projectCaseForViewer, visibleCaseAccess } from "./case-access";

const EXPORT_BATCH = 500;
/** A safety bound per collection; reaching it is reported, never silent. */
const EXPORT_MAX_ROWS = 20_000;

type Page<T> = (cursor: {
  cursor?: { id: string };
  skip?: number;
}) => Promise<T[]>;

async function readAllPages<T extends { id: string }>(
  page: Page<T>,
): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  let after: string | undefined;
  for (;;) {
    const batch = await page(after ? { cursor: { id: after }, skip: 1 } : {});
    rows.push(...batch);
    if (batch.length < EXPORT_BATCH) return { rows, complete: true };
    if (rows.length >= EXPORT_MAX_ROWS) return { rows, complete: false };
    after = batch[batch.length - 1].id;
  }
}

const order = [{ createdAt: "asc" as const }, { id: "asc" as const }];

/**
 * The account's support record for a DPDP §11 export: their cases (including
 * grievances), their own messages, evidence they were asked for and gave,
 * files they uploaded, and their ratings. Internal staff notes are excluded.
 */
export async function readSupportExport(userId: string) {
  const access = await visibleCaseAccess({ userId, role: "CONSULTEE" });
  const cases = await readAllPages((cursor) =>
    prisma.supportCase.findMany({
      where: {
        AND: [
          access.where,
          { OR: [{ requesterUserId: userId }, { submitterUserId: userId }] },
        ],
      },
      orderBy: order,
      take: EXPORT_BATCH,
      ...cursor,
      select: {
        id: true,
        referenceNumber: true,
        title: true,
        description: true,
        category: true,
        priority: true,
        status: true,
        ownershipScope: true,
        organizationId: true,
        requesterUserId: true,
        submitterUserId: true,
        callbackPhone: true,
        callbackWindow: true,
        csatRating: true,
        csatAt: true,
        createdAt: true,
        resolvedAt: true,
        closedAt: true,
      },
    }),
  );
  const messages = await readAllPages((cursor) =>
    prisma.supportCaseMessage.findMany({
      where: { authorUserId: userId, isInternal: false },
      orderBy: order,
      take: EXPORT_BATCH,
      ...cursor,
      select: {
        id: true,
        caseId: true,
        seq: true,
        body: true,
        createdAt: true,
      },
    }),
  );
  const evidence = await readAllPages((cursor) =>
    prisma.supportCaseEvidenceRequest.findMany({
      where: { recipientUserId: userId },
      orderBy: order,
      take: EXPORT_BATCH,
      ...cursor,
      select: {
        id: true,
        caseId: true,
        prompt: true,
        dueAt: true,
        responseBody: true,
        respondedAt: true,
        cancelledAt: true,
        createdAt: true,
      },
    }),
  );
  const attachments = await readAllPages((cursor) =>
    prisma.supportCaseAttachment.findMany({
      where: { uploadedById: userId },
      orderBy: order,
      take: EXPORT_BATCH,
      ...cursor,
      select: {
        id: true,
        caseId: true,
        evidenceRequestId: true,
        originalName: true,
        mimeType: true,
        fileSize: true,
        createdAt: true,
        completedAt: true,
        deletedAt: true,
      },
    }),
  );

  const caseRows = cases.rows.map((row) => {
    const view = projectCaseForViewer(row, userId, access.canCorrespond(row));
    if (view.summaryOnly)
      return {
        id: row.id,
        referenceNumber: row.referenceNumber,
        title: view.summary.title,
        category: row.category,
        status: row.status,
        createdAt: row.createdAt,
        resolvedAt: row.resolvedAt,
        filedByOrganization: true,
      };
    return {
      id: row.id,
      referenceNumber: row.referenceNumber,
      title: row.title,
      description: row.description,
      category: row.category,
      priority: row.priority,
      status: row.status,
      ownershipScope: row.ownershipScope,
      callbackPhone: row.submitterUserId === userId ? row.callbackPhone : null,
      callbackWindow: row.callbackWindow,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
      closedAt: row.closedAt,
      filedByOrganization: false,
    };
  });
  const ratedCaseIds = new Set(
    caseRows.filter((row) => !row.filedByOrganization).map((row) => row.id),
  );

  return {
    supportTickets: caseRows,
    supportGrievances: caseRows.filter((row) => row.category === "GRIEVANCE"),
    supportMessages: messages.rows,
    supportEvidenceRequests: evidence.rows,
    supportAttachments: attachments.rows,
    supportRatings: cases.rows
      .filter((row) => row.csatRating !== null && ratedCaseIds.has(row.id))
      .map((row) => ({
        caseId: row.id,
        rating: row.csatRating,
        ratedAt: row.csatAt,
      })),
    supportExportComplete:
      cases.complete &&
      messages.complete &&
      evidence.complete &&
      attachments.complete,
  };
}
