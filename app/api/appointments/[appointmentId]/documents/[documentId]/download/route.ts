import { getSession } from "@/lib/auth-server";
import { answerFileRoute, fileApiError } from "@/lib/documents/api-error";
import { authorizeAppointmentDocument } from "@/lib/documents/file-access";
import { serveAuthorizedFile } from "@/lib/documents/file-download";

/** Download preflight for a booking document, signed per request for its parties. */
export async function GET(
  request: Request,
  {
    params,
  }: { params: Promise<{ appointmentId: string; documentId: string }> },
) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");
    const { appointmentId, documentId } = await params;
    const access = await authorizeAppointmentDocument(
      session.user.id,
      documentId,
      appointmentId,
    );
    return serveAuthorizedFile(request, access);
  });
}
