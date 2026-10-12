import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth-server";
import { applyRateLimit, documentUploadLimiter } from "@/lib/rate-limit";
import {
  FileRouteError,
  answerFileRoute,
  fileApiError,
  parseJsonBody,
} from "@/lib/documents/api-error";
import { notifyDocumentAdded } from "@/lib/documents/document-notify";
import {
  DocumentCommitSchema,
  commitDocumentUpload,
} from "@/lib/documents/upload-pipeline";
import { readDocumentWorkspace } from "@/lib/documents/workspace";

type RouteContext = { params: Promise<{ appointmentId: string }> };

const NO_STORE = { "Cache-Control": "private, no-store" };

/** The Documents workspace read for a party to the booking. */
export async function GET(_request: Request, { params }: RouteContext) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");
    const { appointmentId } = await params;
    const workspace = await readDocumentWorkspace(
      appointmentId,
      session.user.id,
    );
    if (!workspace) throw new FileRouteError("NOT_FOUND");
    return NextResponse.json(workspace, { headers: NO_STORE });
  });
}

/** Commits an object uploaded through `upload-url` as a document, a new learner version or a shared file. */
export async function POST(request: Request, { params }: RouteContext) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");
    const limited = await applyRateLimit(
      documentUploadLimiter,
      session.user.id,
    );
    if (limited) return limited;

    const { appointmentId } = await params;
    const input = await parseJsonBody(request, DocumentCommitSchema);
    const { document, party } = await commitDocumentUpload({
      appointmentId,
      userId: session.user.id,
      input,
    });
    await notifyDocumentAdded(party, document);

    return NextResponse.json(
      {
        document: {
          id: document.id,
          rootId: document.rootDocumentId ?? document.id,
          versionNo: document.versionNo,
        },
      },
      { status: 201, headers: NO_STORE },
    );
  });
}
