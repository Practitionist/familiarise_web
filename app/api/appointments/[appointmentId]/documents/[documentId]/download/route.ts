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
    if (auth.error) {
      const code =
        auth.error.status === 401
          ? "UNAUTHORIZED"
          : auth.error.status === 403 || auth.error.status === 428
            ? "FORBIDDEN"
            : "SERVER_ERROR";
      return fileApiError(code, { headers: auth.error.headers });
    }
    const { appointmentId, documentId } = await params;
    const access = await authorizeAppointmentDocument(
      auth.session.user.id,
      documentId,
      appointmentId,
    );
    return serveAuthorizedFile(request, access);
  });
}
