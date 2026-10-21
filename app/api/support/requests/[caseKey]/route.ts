import { NextResponse, type NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/auth-helpers";
import { supportError } from "@/lib/api/support-http";
import { parseCaseKey } from "@/lib/support/case-key";
import { readOwnSupportCase } from "@/lib/support/own-case-read";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ caseKey: string }> },
) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { caseKey } = await params;
  const ref = parseCaseKey(caseKey);
  if (!ref || ref.kind === "booking")
    return supportError({ status: 404, code: "NOT_FOUND" });
  const caseId = ref.id;
  const data = caseId
    ? await readOwnSupportCase(caseId, auth.session.user.id)
    : null;
  if (!data) return supportError({ status: 404, code: "NOT_FOUND" });
  return NextResponse.json(
    { data },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
