import { NextResponse } from "next/server";

import { readDocumentLibrary } from "@/lib/data/document-library";
import { timedLibraryRead } from "@/lib/library/timed-read";
import { answerFileRoute } from "@/lib/documents/api-error";
import { personalLibraryRequest } from "@/lib/library/personal-library-route";

/** The personal documents library: one page of bookings with their rows, filters in the query. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  return answerFileRoute(async () => {
    const { consultantId } = await params;
    const library = await personalLibraryRequest(
      request,
      "consultant",
      consultantId,
    );
    if (!library.ok) return library.response;
    const page = await timedLibraryRead("documents:expert", () =>
      readDocumentLibrary({
        userId: library.userId,
        owner: { kind: "personal", side: "expert" },
        query: library.query,
      }),
    );
    return NextResponse.json(page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }, "dashboard");
}
