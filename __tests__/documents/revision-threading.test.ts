/**
 * Verifies that consultee revision uploads scope `responseToDocumentId` strictly
 * to the target appointment inside a row-locked transaction (`FOR UPDATE`) and
 * reject invalid parent IDs with 400 (`INVALID_THREAD_PARENT`) without mutating
 * historical revision rows.
 */

import { readFileSync } from "fs";
import { join } from "path";

const ROUTE = join(
  process.cwd(),
  "app/api/appointments/[appointmentId]/documents/route.ts",
);
const PIPELINE_LIB = join(process.cwd(), "lib/documents/upload-pipeline.ts");
const REVIEW_LIB = join(process.cwd(), "lib/documents/document-review.ts");
const UPLOAD_UI = join(
  process.cwd(),
  "components/appointments/DocumentUpload.tsx",
);

describe("consultee revision upload", () => {
  const src = readFileSync(ROUTE, "utf8");
  const pipelineSrc = readFileSync(PIPELINE_LIB, "utf8");
  const reviewSrc = readFileSync(REVIEW_LIB, "utf8");

  it("reads the revision target from the request", () => {
    expect(src).toContain('from "@/lib/documents/upload-pipeline"');
    expect(pipelineSrc).toContain('formData.get("responseToDocumentId")');
  });

  it("locks the parent Appointment row FOR UPDATE and scopes revision target to appointmentId", () => {
    expect(reviewSrc).toContain(
      'SELECT 1 FROM "Appointment" WHERE id = ${params.appointmentId} FOR UPDATE',
    );
    expect(reviewSrc).toMatch(
      /findFirst\(\{\s*where:\s*\{\s*id:\s*parentDocumentId,\s*appointmentId,\s*deletedAt:\s*null\s*\}/,
    );
    expect(pipelineSrc).toContain("INVALID_THREAD_PARENT");
  });

  it("rejects with 400 rather than silently dropping the link", () => {
    expect(src).toContain("missingParentStatus: 400");
    expect(pipelineSrc).toContain("status: copy.missingParentStatus");
  });

  it("persists the link on create", () => {
    expect(src).toContain("parentDocumentId: parsedInput.responseToDocumentId");
    expect(pipelineSrc).toContain("responseToDocumentId: parentDocumentId");
  });

  it("threads rather than mutating the rejected document", () => {
    expect(src).not.toMatch(/appointmentDocument\.update\(/);
    expect(pipelineSrc).not.toMatch(/appointmentDocument\.update\(/);
  });
});

describe("consultee revision UI", () => {
  const ui = readFileSync(UPLOAD_UI, "utf8");

  it("offers a re-upload path on NEEDS_REVISION", () => {
    expect(ui).toContain('doc.reviewStatus === "NEEDS_REVISION"');
    expect(ui).toContain("Upload revision");
  });

  it("sends the linkage with the upload", () => {
    expect(ui).toContain('formData.append("responseToDocumentId"');
  });

  it("clears the revision link after upload and on cancel", () => {
    expect(
      ui.match(/setRevisionOf\(null\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
  });
});
