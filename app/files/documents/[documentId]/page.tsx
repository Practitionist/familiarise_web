import type { Metadata } from "next";
import Link from "next/link";

import { FileViewer, FileViewerError } from "@/components/documents/FileViewer";
import { Button } from "@/components/ui/button";
import { requireApiAuth } from "@/lib/auth-helpers";
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
  const auth = await requireApiAuth();
  if (auth.error) {
    // A privileged account without 2FA can otherwise open customer files
    // through this page, which lives outside the back-office layout guard.
    if (auth.error.status === 428) {
      return (
        <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
          <h1 className="text-2xl font-semibold text-foreground">
            Two-factor authentication required
          </h1>
          <p className="text-sm text-muted-foreground">
            Set up two-factor authentication before opening a customer document.
          </p>
          <Button asChild>
            <Link href="/auth/two-factor/setup">
              Set up two-factor authentication
            </Link>
          </Button>
        </main>
      );
    }
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
