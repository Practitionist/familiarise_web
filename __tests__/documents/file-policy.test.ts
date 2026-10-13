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

  it("reads a CSV reported as Excel by its extension", () => {
    const excel = { size: 1000, type: "application/vnd.ms-excel" };
    expect(validateUploadFile({ ...excel, name: "marks.csv" })).toEqual({
      ok: true,
      mimeType: "text/csv",
    });
    expect(validateUploadFile({ ...excel, name: "marks.xls" })).toEqual({
      ok: true,
      mimeType: "application/vnd.ms-excel",
    });
    expect(validateUploadFile({ ...excel, name: "marks.txt" }).ok).toBe(false);
  });
});
