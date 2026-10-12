import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import {
  FILE_ACCESS_STATUS,
  authorizePlanMaterial,
  signAuthorizedFile,
} from "@/lib/documents/file-access";

/** Issues 60s presigned download/preview URLs for authorized plan materials (`Cache-Control: private, no-store`). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> },
) {
  try {
    const { materialId } = await params;
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to access plan materials",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const access = await authorizePlanMaterial(session.user.id, materialId);
    if (!access.ok) {
      return NextResponse.json(
        { error: "Material unavailable", code: access.code },
        { status: FILE_ACCESS_STATUS[access.code] },
      );
    }

    const searchParams = new URL(request.url).searchParams;
    const disposition =
      searchParams.get("disposition") === "attachment"
        ? "attachment"
        : "inline";
    const signed = await signAuthorizedFile(access.file, disposition, 60);

    if (!signed.ok) {
      if (signed.code === "STORAGE_CONFIG_ERROR") {
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
      { tags: { subsystem: "plans" } },
    );
    return NextResponse.json(
      { error: "Server error", code: "SERVER_ERROR" },
      { status: 500 },
    );
  }
}
