/**
 * @jest-environment node
 */

/**
 * The evidence attachment's declared file name.
 *
 * The name is part of the storage key, so a path separator or a control
 * character in it would let the upload walk out of the case's own prefix.
 * The check is by code point rather than by a control-character regex, which
 * keeps the same rule without the lint rule that regex trips.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../lib/supabase-storage-core", () => ({
  adminStorage: jest.fn(),
}));

jest.mock("../../lib/support/case-access", () => ({
  canCorrespondOnCase: jest.fn(async () => true),
}));

jest.mock("../../lib/support/case-actions", () => ({
  CaseActionError: class CaseActionError extends Error {},
}));

import { AttachmentUploadSchema } from "../../lib/support/case-attachments";

const base = { mimeType: "application/pdf", fileSize: 1024 };

describe("the declared attachment name", () => {
  it("accepts an ordinary file name", () => {
    const parsed = AttachmentUploadSchema.safeParse({
      ...base,
      originalName: "invoice-2026-03.pdf",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a name that would escape the storage prefix", () => {
    for (const originalName of [
      "../invoice.pdf",
      "sub/invoice.pdf",
      "sub\\invoice.pdf",
      "invoice\u0007.pdf",
      "invoice\u0000.pdf",
    ]) {
      const parsed = AttachmentUploadSchema.safeParse({
        ...base,
        originalName,
      });
      expect(parsed.success).toBe(false);
    }
  });
});
