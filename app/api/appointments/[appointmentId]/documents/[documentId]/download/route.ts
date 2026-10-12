import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import {
  FILE_ACCESS_STATUS,
  authorizeAppointmentDocument,
  signAuthorizedFile,
} from "@/lib/documents/file-access";

/** Download preflight: `?format=json` returns a 60 s signed link, otherwise redirects to it. */
export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ appointmentId: string; documentId: string }> },
) {
  try {
    const { appointmentId, documentId } = await params;

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to download documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const access = await authorizeAppointmentDocument(
      session.user.id,
      documentId,
      appointmentId,
    );
    if (!access.ok) {
      return NextResponse.json(
        { error: "Document unavailable", code: access.code },
        { status: FILE_ACCESS_STATUS[access.code] },
      );
    }

    const searchParams = new URL(request.url).searchParams;
    const disposition =
      searchParams.get("disposition") === "inline" ? "inline" : "attachment";
    const signed = await signAuthorizedFile(access.file, disposition, 60);

    if (!signed.ok) {
      if (signed.code === "STORAGE_CONFIG_ERROR") {
        Sentry.captureException(
          new Error("Supabase admin client not configured"),
          { tags: { subsystem: "appointments" } },
        );
        return NextResponse.json(
          { error: "Storage unavailable", code: "STORAGE_UNAVAILABLE" },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { error: "File unavailable", code: "STORAGE_MISSING" },
        { status: 404 },
      );
    }

    const wantsJson =
      searchParams.get("format") === "json" ||
      request.headers.get("accept")?.includes("application/json");

    if (wantsJson) {
      return NextResponse.json(
        {
          signedUrl: signed.signedUrl,
          mimeType: access.file.mimeType,
          originalName: access.file.originalName,
          previewable: access.file.previewable,
        },
        {
          status: 200,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }

    return NextResponse.redirect(signed.signedUrl, {
      status: 302,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );
    return NextResponse.json(
      { error: "Server error", code: "SERVER_ERROR" },
      { status: 500 },
    );
  }
}
