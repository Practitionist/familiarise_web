import { NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, documentCommitLimiter } from "@/lib/rate-limit";
import {
  FileRouteError,
  answerFileRoute,
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
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const { appointmentId } = await params;
    const workspace = await readDocumentWorkspace(
      appointmentId,
      auth.session.user.id,
    );
    if (!workspace) throw new FileRouteError("NOT_FOUND");
    return NextResponse.json(workspace, { headers: NO_STORE });
  });
}

/** Commits an object uploaded through `upload-url` as a document, a new learner version or a shared file. */
export async function POST(request: Request, { params }: RouteContext) {
  return answerFileRoute(async () => {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const { appointmentId } = await params;
    const limited = await applyRateLimit(
      documentCommitLimiter,
      auth.session.user.id,
    );
    // A rate-limited commit keeps its object: the client retries the same path,
    // and a delete here could race a concurrent commit of that path.
    if (limited) return limited;

    const input = await parseJsonBody(request, DocumentCommitSchema);
    const { document, party, replayed } = await commitDocumentUpload({
      appointmentId,
      userId: auth.session.user.id,
      input,
    });
    // A replay is the same document, not a second upload: no second notice.
    if (!replayed) await notifyDocumentAdded(party, document);

    return NextResponse.json(
      {
        document: {
          id: document.id,
          rootId: document.rootDocumentId ?? document.id,
          versionNo: document.versionNo,
        },
      },
      { status: replayed ? 200 : 201, headers: NO_STORE },
    );
  });
}
