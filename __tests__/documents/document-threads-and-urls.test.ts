/**
 * @jest-environment node
 */

import {
  groupDocumentsIntoThreads,
  isReviewTransitionAllowed,
} from "@/lib/documents/document-review";
import {
  formatContentDisposition,
  getAppointmentDocumentUrl,
  getPlanMaterialUrl,
  isPreviewableMimeType,
} from "@/lib/documents/urls";

describe("groupDocumentsIntoThreads", () => {
  it("groups multi-round learner revisions and consultant responses into a single root thread", () => {
    const threads = groupDocumentsIntoThreads([
      {
        id: "doc-v3",
        appointmentId: "appt-1",
        originalName: "Resume_Kaustav_v3.pdf",
        fileSize: 210_000,
        mimeType: "application/pdf",
        reviewStatus: "PENDING",
        reviewNotes: null,
        uploadedByRole: "CONSULTEE",
        uploadedAt: "2026-10-10T10:00:00Z",
        versionNo: 3,
        rootDocumentId: "doc-v1",
        responseToDocumentId: "doc-v2",
      },
      {
        id: "doc-v2",
        appointmentId: "appt-1",
        originalName: "Resume_Kaustav_annotated.pdf",
        fileSize: 225_000,
        mimeType: "application/pdf",
        reviewStatus: "APPROVED",
        reviewNotes: "Tighten impact metrics in top 2 roles.",
        uploadedByRole: "CONSULTANT",
        uploadedAt: "2026-10-10T09:00:00Z",
        versionNo: 2,
        rootDocumentId: "doc-v1",
        responseToDocumentId: "doc-v1",
      },
      {
        id: "doc-v1",
        appointmentId: "appt-1",
        originalName: "Resume_Kaustav.pdf",
        fileSize: 200_000,
        mimeType: "application/pdf",
        reviewStatus: "NEEDS_REVISION",
        reviewNotes: "Add quantified metrics.",
        uploadedByRole: "CONSULTEE",
        uploadedAt: "2026-10-10T08:00:00Z",
        versionNo: 1,
        rootDocumentId: null,
        responseToDocumentId: null,
      },
      {
        id: "portfolio-v1",
        appointmentId: "appt-1",
        originalName: "Portfolio.pdf",
        fileSize: 500_000,
        mimeType: "application/pdf",
        reviewStatus: "APPROVED",
        reviewNotes: "Looks great!",
        uploadedByRole: "CONSULTEE",
        uploadedAt: "2026-10-10T07:00:00Z",
        versionNo: 1,
        rootDocumentId: null,
        responseToDocumentId: null,
      },
    ]);

    expect(threads).toHaveLength(2);
    expect(threads[0].rootId).toBe("doc-v1");
    expect(threads[0].versionCount).toBe(3);
    expect(threads[0].versions.map((v) => v.id)).toEqual([
      "doc-v1",
      "doc-v2",
      "doc-v3",
    ]);
    expect(threads[0].latestVersion.id).toBe("doc-v3");
    expect(threads[0].latestConsulteeSubmission?.id).toBe("doc-v3");
    expect(threads[0].latestConsultantResponse?.id).toBe("doc-v2");
    expect(threads[0].effectiveStatus).toBe("PENDING");
    expect(threads[0].effectiveReviewNotes).toBe(
      "Tighten impact metrics in top 2 roles.",
    );
    expect(threads[1].rootId).toBe("portfolio-v1");
  });
});

describe("canonical non-expiring URLs, Content-Disposition, and review transition rules", () => {
  it("builds inline and attachment streaming paths without expiring JWT query tokens", () => {
    expect(getAppointmentDocumentUrl("appt-1", "doc-1", "inline")).toBe(
      "/api/appointments/appt-1/documents/doc-1/download?disposition=inline",
    );
    expect(getAppointmentDocumentUrl("appt-1", "doc-1", "attachment")).toBe(
      "/api/appointments/appt-1/documents/doc-1/download?disposition=attachment",
    );
    expect(getPlanMaterialUrl("mat-1", "inline")).toBe(
      "/api/plans/materials/mat-1/download?disposition=inline",
    );
    expect(getPlanMaterialUrl("mat-1", "attachment")).toBe(
      "/api/plans/materials/mat-1/download?disposition=attachment",
    );
  });

  it("formats RFC 6266 Content-Disposition headers with ASCII fallback and UTF-8 filename*", () => {
    const header = formatContentDisposition(
      "inline",
      'Résumé — Kaustav\'s "v2".pdf',
    );
    expect(header).toContain('inline; filename="R_sum_ _ Kaustav\'s _v2_.pdf"');
    expect(header).toContain("filename*=UTF-8''");
  });

  it("identifies previewable MIME types accurately", () => {
    expect(isPreviewableMimeType("application/pdf")).toBe(true);
    expect(isPreviewableMimeType("image/png")).toBe(true);
    expect(isPreviewableMimeType("text/plain")).toBe(true);
    expect(
      isPreviewableMimeType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(false);
  });

  it("permits note-only updates on decided statuses while blocking reopening to another status", () => {
    expect(isReviewTransitionAllowed("APPROVED", "APPROVED")).toBe(true);
    expect(isReviewTransitionAllowed("REJECTED", "REJECTED")).toBe(true);
    expect(isReviewTransitionAllowed("APPROVED", "NEEDS_REVISION")).toBe(false);
    expect(isReviewTransitionAllowed("REJECTED", "PENDING")).toBe(false);
  });
});
