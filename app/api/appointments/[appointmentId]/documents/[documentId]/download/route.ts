import { requireApiAuth } from "@/lib/auth-helpers";
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
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const { appointmentId, documentId } = await params;
    const access = await authorizeAppointmentDocument(
      auth.session.user.id,
      documentId,
      appointmentId,
    );
    return serveAuthorizedFile(request, access);
  });
}
