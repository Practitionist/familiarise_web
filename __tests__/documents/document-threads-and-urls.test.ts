/**
 * @jest-environment node
 */

import { isReviewTransitionAllowed } from "@/lib/documents/document-review";
import {
  getAppointmentDocumentUrl,
  getPlanMaterialUrl,
  isPreviewableMimeType,
} from "@/lib/documents/urls";

describe("canonical non-expiring URLs, preview allowlist, and review transition rules", () => {
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

  it("identifies previewable MIME types and blocks non-previewable Office/archive extensions", () => {
    expect(isPreviewableMimeType("application/pdf", "Resume.pdf")).toBe(true);
    expect(isPreviewableMimeType("image/png", "Portfolio.png")).toBe(true);
    expect(isPreviewableMimeType("text/plain", "Notes.txt")).toBe(true);
    expect(
      isPreviewableMimeType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Resume.docx",
      ),
    ).toBe(false);
    // Even if a seeded or legacy row recorded application/pdf, .docx/.xlsx/.zip never render inline
    expect(isPreviewableMimeType("application/pdf", "Resume_Seeded.docx")).toBe(
      false,
    );
    expect(isPreviewableMimeType("application/pdf", "Sheet.xlsx")).toBe(false);
    expect(isPreviewableMimeType("text/plain", "Export.csv")).toBe(false);
  });

  it("permits note-only updates on decided statuses while blocking reopening to another status", () => {
    expect(isReviewTransitionAllowed("APPROVED", "APPROVED")).toBe(true);
    expect(isReviewTransitionAllowed("REJECTED", "REJECTED")).toBe(true);
    expect(isReviewTransitionAllowed("APPROVED", "NEEDS_REVISION")).toBe(false);
    expect(isReviewTransitionAllowed("REJECTED", "PENDING")).toBe(false);
  });
});
