import { NextResponse } from "next/server";

import { readDocumentLibrary } from "@/lib/data/document-library";
import { timedLibraryRead } from "@/lib/library/timed-read";
import { answerFileRoute } from "@/lib/documents/api-error";
import { personalLibraryRequest } from "@/lib/library/personal-library-route";

/** The personal documents library: one page of bookings with their rows, filters in the query. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  return answerFileRoute(async () => {
    const { consulteeId } = await params;
    const library = await personalLibraryRequest(
      request,
      "consultee",
      consulteeId,
    );
    if (!library.ok) return library.response;
    const page = await timedLibraryRead("documents:learner", () =>
      readDocumentLibrary({
        userId: library.userId,
        owner: { kind: "personal", side: "learner" },
        query: library.query,
      }),
    );
    return NextResponse.json(page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }, "dashboard");
}
