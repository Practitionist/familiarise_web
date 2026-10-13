import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { fileApiError } from "./api-error";
import { signAuthorizedFile, type FileAccessOutcome } from "./file-access";

const DOWNLOAD_LINK_TTL_SECONDS = 60;

const DownloadQuerySchema = z.object({
  disposition: z.enum(["inline", "attachment"]).catch("attachment"),
  format: z.enum(["json", "redirect"]).catch("redirect"),
});

/**
 * Answers an authorised download: `?format=json` returns a 60-second signed
 * link for the page to save; otherwise redirects to it. Never cached.
 */
export async function serveAuthorizedFile(
  request: Request,
  access: FileAccessOutcome,
): Promise<Response> {
  if (!access.ok) return fileApiError(access.code);

  const query = DownloadQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  const signed = await signAuthorizedFile(
    access.file,
    query.disposition,
    DOWNLOAD_LINK_TTL_SECONDS,
  );
  if (!signed.ok) return fileApiError(signed.code);

  const headers = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  };
  if (
    query.format === "json" ||
    request.headers.get("accept")?.includes("application/json")
  ) {
    return NextResponse.json(
      {
        signedUrl: signed.signedUrl,
        mimeType: access.file.mimeType,
        originalName: access.file.originalName,
      },
      { headers },
    );
  }
  return NextResponse.redirect(signed.signedUrl, { status: 302, headers });
}
