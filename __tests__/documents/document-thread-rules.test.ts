/**
 * @jest-environment node
 */

import { documentDates } from "@/lib/documents/document-dates";
import { resolveDocumentThreadSlot } from "@/lib/documents/document-review";
import { buildThreadViews, type ThreadRow } from "@/lib/documents/thread-view";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-12T00:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

function row(partial: Partial<ThreadRow> & { id: string }): ThreadRow {
  return {
    rootDocumentId: null,
    versionNo: 1,
    uploadedByRole: "CONSULTEE",
    originalName: `${partial.id}.pdf`,
    mimeType: "application/pdf",
    fileSize: 1000,
    description: null,
    reviewStatus: "PENDING",
    reviewNotes: null,
    reviewedAt: null,
    uploadedAt: daysAgo(10),
    isStorageMissing: false,
    removalRequestedAt: null,
    ...partial,
  };
}

describe("upload window and retention dates", () => {
  it("stays open while sessions remain, then closes 30 days and keeps 90 days after the last one", () => {
    const running = documentDates(
      {
        terminal: false,
        terminalAt: null,
        liveSessionEnds: [daysAgo(5), new Date(now.getTime() + DAY)],
        activeUntil: null,
      },
      now,
    );
    expect(running).toMatchObject({
      uploadWindowOpen: true,
      uploadWindowClosesAt: null,
      keptUntil: null,
    });

    const ended = documentDates(
      {
        terminal: false,
        terminalAt: null,
        liveSessionEnds: [daysAgo(40), daysAgo(31)],
        activeUntil: null,
      },
      now,
    );
    expect(ended.uploadWindowOpen).toBe(false);
    expect(ended.uploadWindowClosesAt).toEqual(daysAgo(1));
    expect(ended.keptUntil).toEqual(new Date(daysAgo(31).getTime() + 90 * DAY));
  });

  it("makes a cancelled booking read-only at once and keeps it 90 days after the cancellation", () => {
    const cancelled = documentDates(
      {
        terminal: true,
        terminalAt: daysAgo(2),
        liveSessionEnds: [new Date(now.getTime() + 5 * DAY)],
        activeUntil: null,
      },
      now,
    );
    expect(cancelled.uploadWindowOpen).toBe(false);
    expect(cancelled.keptUntil).toEqual(
      new Date(daysAgo(2).getTime() + 90 * DAY),
    );
  });
});

describe("server-built document threads", () => {
  it("derives status from the latest learner version and never from an expert reply", () => {
    const [thread] = buildThreadViews(
      [
        row({ id: "r", reviewStatus: "NEEDS_REVISION", reviewNotes: "Fix 2" }),
        row({
          id: "x",
          rootDocumentId: "r",
          versionNo: 2,
          uploadedByRole: "CONSULTANT",
          reviewStatus: "APPROVED",
        }),
        row({ id: "v3", rootDocumentId: "r", versionNo: 3 }),
      ],
      { viewerRole: "learner", writable: true },
    );
    expect(thread).toMatchObject({
      status: "WAITING_FOR_EXPERT",
      reviewTargetId: "v3",
      learnerVersions: { used: 2, max: 10 },
    });
    expect(
      thread!.versions.map((v) => [v.label, v.reviewStatus, v.superseded]),
    ).toEqual([
      ["Your version", "NEEDS_REVISION", true],
      ["Expert reply", null, false],
      ["Your version", "PENDING", false],
    ]);
    expect(thread!.allowedActions).toEqual(
      expect.arrayContaining(["upload_version", "withdraw_latest"]),
    );
    expect(thread!.allowedActions).not.toContain("request_removal");
  });

  it("offers review to the expert only while open, and nothing once read-only", () => {
    const rows = [row({ id: "r", reviewStatus: "IN_REVIEW" })];
    const [expert] = buildThreadViews(rows, {
      viewerRole: "expert",
      writable: true,
    });
    expect(expert!.allowedActions).toEqual(["review"]);
    const [learner] = buildThreadViews(rows, {
      viewerRole: "learner",
      writable: true,
    });
    expect(learner!.allowedActions).toEqual(["request_removal"]);
    const [closed] = buildThreadViews(rows, {
      viewerRole: "expert",
      writable: false,
    });
    expect(closed!.allowedActions).toEqual([]);
  });

  it("treats an expert root as a shared file with its own actions", () => {
    const [shared] = buildThreadViews(
      [
        row({
          id: "s",
          uploadedByRole: "CONSULTANT",
          reviewStatus: "APPROVED",
        }),
      ],
      { viewerRole: "expert", writable: true },
    );
    expect(shared).toMatchObject({
      kind: "shared",
      status: "SHARED",
      allowedActions: ["delete_shared"],
    });
  });

  it("shows a removal request on the banner and stops offering another", () => {
    const [thread] = buildThreadViews(
      [
        row({
          id: "r",
          reviewStatus: "APPROVED",
          removalRequestedAt: daysAgo(1),
        }),
      ],
      { viewerRole: "learner", writable: true },
    );
    expect(thread!.banner.kind).toBe("REMOVAL_REQUESTED");
    expect(thread!.allowedActions).not.toContain("request_removal");
  });
});

describe("learner version slot under the booking lock", () => {
  async function learnerSlot(
    rootRole: "CONSULTEE" | "CONSULTANT",
    live: { uploadedByRole: string; reviewStatus: string; versionNo: number }[],
  ) {
    const tx = {
      appointmentDocument: {
        findFirst: jest.fn().mockResolvedValue({
          id: "v-latest",
          rootDocumentId: "root-1",
          uploadedByRole: "CONSULTEE",
          rootDocument: { uploadedByRole: rootRole },
        }),
        findMany: jest.fn().mockResolvedValue(live),
        aggregate: jest.fn().mockResolvedValue({
          _max: { versionNo: Math.max(...live.map((v) => v.versionNo)) },
        }),
        count: jest.fn(),
      },
    };
    return resolveDocumentThreadSlot(tx as never, {
      appointmentId: "apt-1",
      parentDocumentId: "v-latest",
      uploadedByRole: "CONSULTEE",
    });
  }
  const learner = (versionNo: number, reviewStatus = "NEEDS_REVISION") => ({
    uploadedByRole: "CONSULTEE",
    reviewStatus,
    versionNo,
  });
  const reply = (versionNo: number) => ({
    uploadedByRole: "CONSULTANT",
    reviewStatus: "APPROVED",
    versionNo,
  });

  it.each([
    ["IN_REVIEW", "THREAD_IN_REVIEW"],
    ["APPROVED", "THREAD_CLOSED"],
    ["REJECTED", "THREAD_CLOSED"],
  ])(
    "refuses a version while the latest learner row is %s",
    async (s, code) => {
      await expect(
        learnerSlot("CONSULTEE", [learner(1), reply(2), learner(3, s)]),
      ).rejects.toMatchObject({ code });
    },
  );

  it("refuses versions on a shared file and caps learner versions at 10, not counting replies", async () => {
    await expect(learnerSlot("CONSULTANT", [reply(1)])).rejects.toMatchObject({
      code: "THREAD_CLOSED",
    });
    const ten = Array.from({ length: 10 }, (_, i) => learner(i * 2 + 1));
    await expect(
      learnerSlot("CONSULTEE", [...ten, reply(2)]),
    ).rejects.toMatchObject({ code: "VERSION_LIMIT_REACHED" });
    const nine = Array.from({ length: 9 }, (_, i) => learner(i * 2 + 1));
    const replies = Array.from({ length: 8 }, (_, i) => reply(i * 2 + 2));
    await expect(
      learnerSlot("CONSULTEE", [...nine, ...replies]),
    ).resolves.toEqual({ rootDocumentId: "root-1", versionNo: 18 });
  });
});
