/**
 * The refund door shows how much of a digital product sale the buyer took,
 * as evidence only: the count and the first download, in IST.
 */
import { downloadEvidenceText } from "@/components/dashboard/backoffice/money/DownloadEvidence";

const purchase = (downloads: number, firstDownloadedAt: string | null) => ({
  status: "SUCCEEDED",
  firstDownloadedAt,
  product: { title: "Workbook" },
  _count: { downloads },
});

it("states the download count and the first download time", () => {
  expect(downloadEvidenceText(purchase(0, null))).toBe("Not downloaded yet");
  expect(downloadEvidenceText(purchase(1, "2026-11-02T08:30:00Z"))).toBe(
    "Downloaded 1 time, first at 2 Nov 2026, 2:00 pm IST",
  );
  expect(downloadEvidenceText(purchase(31, "2026-11-02T08:30:00Z"))).toMatch(
    /^Downloaded 31 times, first at /,
  );
});
