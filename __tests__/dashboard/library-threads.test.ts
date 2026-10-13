/**
 * The Documents library row: one thread per root with every version newest
 * first, earlier learner versions superseded, and rows that need the viewer
 * sorted first.
 */

import { buildThreadViews, type ThreadRow } from "@/lib/documents/thread-view";
import { toLibraryThread } from "@/lib/library/document-threads";
import { compareLibraryThreads } from "@/lib/library/library-query";

function row(over: Partial<ThreadRow> & { id: string }): ThreadRow {
  return {
    rootDocumentId: null,
    versionNo: 1,
    uploadedByRole: "CONSULTEE",
    originalName: `${over.id}.pdf`,
    mimeType: "application/pdf",
    fileSize: 10,
    description: null,
    reviewStatus: "PENDING",
    reviewNotes: null,
    reviewedAt: null,
    uploadedAt: new Date("2026-10-01T10:00:00Z"),
    isStorageMissing: false,
    removalRequestedAt: null,
    ...over,
  };
}

const names = { learnerName: "Ethan Brown", expertName: "Angela Anderson" };

describe("Documents library threads", () => {
  it("folds versions under the root, newest first, with the expert reply labelled", () => {
    const [view] = buildThreadViews(
      [
        row({ id: "d", reviewStatus: "NEEDS_REVISION", reviewNotes: "Fix p2" }),
        row({
          id: "r",
          rootDocumentId: "d",
          versionNo: 2,
          uploadedByRole: "CONSULTANT",
          uploadedAt: new Date("2026-10-02T10:00:00Z"),
        }),
        row({
          id: "e",
          rootDocumentId: "d",
          versionNo: 3,
          originalName: "e.pdf",
          uploadedAt: new Date("2026-10-03T10:00:00Z"),
        }),
      ],
      { viewerRole: "learner", writable: true },
    );
    const thread = toLibraryThread(view!, {
      viewerRole: "learner",
      ...names,
    });
    expect(thread).toMatchObject({
      id: "d",
      title: "d.pdf",
      startedBy: "You",
      source: "mine",
      versionCount: 3,
      latest: { id: "e", versionNo: 3, originalName: "e.pdf" },
    });
    expect(
      thread.versions.map((v) => [
        v.versionNo,
        v.uploadedBy,
        v.isExpertReply,
        v.reviewStatus,
        v.reviewNotesExcerpt,
      ]),
    ).toEqual([
      [3, "You", false, "PENDING", null],
      [2, "Angela", true, null, null],
      [1, "You", false, "SUPERSEDED", "Fix p2"],
    ]);
  });

  it("puts threads that need the viewer first, then the latest update, then id", () => {
    const t = (id: string, needsYou: boolean, at: string) => ({
      id,
      needsYou,
      latest: { id, versionNo: 1, originalName: id, uploadedAt: at, url: "" },
    });
    const sorted = [
      t("b", false, "2026-10-05T00:00:00.000Z"),
      t("c", true, "2026-10-01T00:00:00.000Z"),
      t("a", false, "2026-10-05T00:00:00.000Z"),
      t("d", false, "2026-10-09T00:00:00.000Z"),
    ].sort(compareLibraryThreads);
    expect(sorted.map((x) => x.id)).toEqual(["c", "d", "a", "b"]);
  });
});
