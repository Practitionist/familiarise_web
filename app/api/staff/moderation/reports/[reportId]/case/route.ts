import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  openReportCaseTx,
  readReportCaseOptions,
} from "@/lib/moderation/report-case";
import { reportSentryError } from "@/lib/observability/report";
import { OpenReportCaseShape } from "@/schemas/moderation";

interface RouteParams {
  params: Promise<{ reportId: string }>;
}

// ModerationReport.id is a uuid, so anything else can only miss.
const ReportId = z.string().uuid();

const REPORT_NOT_FOUND = {
  error: "Report not found.",
  code: "NOT_FOUND",
} as const;

/** The open-case dialog's data: the linked case, or the bookings reporter and target share. */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireBackofficeSurface("tickets.manage");
  if (auth.error) return auth.error;
  const reportId = ReportId.safeParse((await params).reportId);
  if (!reportId.success) {
    return NextResponse.json(REPORT_NOT_FOUND, { status: 404 });
  }
  try {
    const options = await readReportCaseOptions(reportId.data);
    if (!options) {
      return NextResponse.json(REPORT_NOT_FOUND, { status: 404 });
    }
    return NextResponse.json(options);
  } catch (err) {
    reportSentryError(err, { subsystem: "moderation", op: "report-case:read" });
    return NextResponse.json(
      { error: "Something went wrong — please try again.", code: "FAILED" },
      { status: 500 },
    );
  }
}

/** Opens the reporter's support case on a booking both users share, once per report. */
export const POST = withOpsAction(
  "tickets.manage",
  "moderation.report.open-case",
  OpenReportCaseShape,
  {
    mode: "tx",
    run: async (tx, { body, actor, params }) => {
      const reportId = ReportId.safeParse(params.reportId);
      if (!reportId.success) {
        throw new OpsRefusal(
          REPORT_NOT_FOUND.code,
          REPORT_NOT_FOUND.error,
          404,
        );
      }
      const { linkedCase } = await openReportCaseTx(tx, {
        reportId: reportId.data,
        appointmentId: body.appointmentId,
        category: body.category,
        actorUserId: actor.userId,
      });
      return {
        target: { kind: "ModerationReport", id: reportId.data },
        response: { case: linkedCase },
        status: 201,
        before: { caseId: null },
        after: {
          caseId: linkedCase.id,
          appointmentId: body.appointmentId,
          category: body.category,
        },
        correlationId: `support-case:${linkedCase.id}`,
      };
    },
  },
);
