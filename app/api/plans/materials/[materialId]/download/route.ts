import { getSession } from "@/lib/auth-server";
import { answerFileRoute, fileApiError } from "@/lib/documents/api-error";
import { authorizePlanMaterial } from "@/lib/documents/file-access";
import { serveAuthorizedFile } from "@/lib/documents/file-download";

/** Download preflight for a plan material, signed per request for the people who can list it. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ materialId: string }> },
) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");
    const { materialId } = await params;
    const access = await authorizePlanMaterial(session.user.id, materialId);
    return serveAuthorizedFile(request, access);
  }, "plans");
}
