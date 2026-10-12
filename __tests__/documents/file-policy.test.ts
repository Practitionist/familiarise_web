import { validateUploadFile } from "@/lib/documents/file-policy";

describe("file policy", () => {
  it("accepts a name only when its extension fits the resolved type", () => {
    const pdf = { size: 1000, type: "application/pdf" };
    expect(validateUploadFile({ ...pdf, name: "notes.PDF" })).toEqual({
      ok: true,
      mimeType: "application/pdf",
    });
    expect(validateUploadFile({ ...pdf, name: "notes" }).ok).toBe(true);
    expect(validateUploadFile({ ...pdf, name: "notes.exe" })).toEqual({
      ok: false,
      code: "UNSUPPORTED_FILE_TYPE",
    });
    expect(
      validateUploadFile({ size: 1000, type: "", name: "sheet.xlsx" }).ok,
    ).toBe(true);
  });
});
