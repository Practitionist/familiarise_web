import type { Metadata } from "next";

import { FileViewer, FileViewerError } from "@/components/documents/FileViewer";
import { getSession } from "@/lib/auth-server";
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
  const session = await getSession();
  if (!session?.user?.id) {
    return <FileViewerError code="UNAUTHORIZED" callbackPath={callbackPath} />;
  }
  const access = await authorizeAppointmentDocument(
    session.user.id,
    documentId,
  );
  return <FileViewer access={access} callbackPath={callbackPath} />;
}
