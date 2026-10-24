import type { Metadata } from "next";

import { FileViewer, FileViewerError } from "@/components/documents/FileViewer";
import { requireApiSession } from "@/lib/auth-helpers";
import { authorizeAppointmentDocument } from "@/lib/documents/file-access";
import { getDocumentViewerUrl } from "@/lib/documents/urls";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Document",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function DocumentViewerPage({
  params,
}: Readonly<{ params: Promise<{ documentId: string }> }>) {
  const { documentId } = await params;
  const callbackPath = getDocumentViewerUrl(documentId);
  const auth = await requireApiSession();
  if (auth.error) {
    const code =
      auth.error.status === 403
        ? "FORBIDDEN"
        : auth.error.status >= 500
          ? "SERVER_ERROR"
          : "UNAUTHORIZED";
    return <FileViewerError code={code} callbackPath={callbackPath} />;
  }
  const access = await authorizeAppointmentDocument(
    auth.session.user.id,
    documentId,
  );
  return <FileViewer access={access} callbackPath={callbackPath} />;
}
