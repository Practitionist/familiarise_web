/**
 * @jest-environment node
 */

/**
 * A buyer's file view: a file added after purchase is "New" and a newer
 * version is "Updated" until the buyer downloads it, names never follow a
 * replacement, and a file removed after purchase is listed with its date.
 */
jest.mock("server-only", () => ({}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  buyerFileView,
  type BuyerAssetRow,
} from "../../lib/digital-products/buyer-files";

const at = (day: number) => new Date(Date.UTC(2026, 10, day, 6));
const row = (
  id: string,
  lineageId: string,
  version: number,
  liveDay: number,
  supersededDay: number | null = null,
): BuyerAssetRow => ({
  id,
  lineageId,
  version,
  status: supersededDay === null ? "VERIFIED" : "SUPERSEDED",
  originalName: `${id}.pdf`,
  sizeBytes: 10,
  order: 0,
  createdAt: at(liveDay),
  verifiedAt: at(liveDay),
  supersededAt: supersededDay === null ? null : at(supersededDay),
});

it("badges new and updated files until downloaded, keeps first names and lists removals", () => {
  const purchasedAt = at(5);
  const rows = [
    row("doc", "doc", 1, 1, 7),
    row("doc-v2", "doc", 2, 7),
    row("extra", "extra", 1, 8),
    row("gone", "gone", 1, 2, 9),
    row("old", "old", 1, 1, 3),
  ];
  const names = new Map([
    ["doc", "doc.pdf"],
    ["extra", "extra.pdf"],
    ["gone", "gone.pdf"],
  ]);
  const before = buyerFileView({
    purchasedAt,
    rows,
    lastDownloadByLineage: new Map(),
    names,
  });
  expect(before.files.map((f) => [f.name, f.badge])).toEqual([
    ["doc.pdf", "updated"],
    ["extra.pdf", "new"],
  ]);
  expect(before.files[0].updatedAt).toEqual(at(7));
  // Removed after purchase is listed; one superseded before it never was theirs.
  expect(before.removed).toEqual([
    { lineageId: "gone", name: "gone.pdf", removedAt: at(9) },
  ]);

  const after = buyerFileView({
    purchasedAt,
    rows,
    lastDownloadByLineage: new Map([
      ["doc", at(10)],
      ["extra", at(10)],
    ]),
    names,
  });
  expect(after.files.map((f) => f.badge)).toEqual([null, null]);

  // Downloaded, then replaced again: updated, not new.
  const replaced = buyerFileView({
    purchasedAt,
    rows: [row("extra", "extra", 1, 8, 12), row("extra-v2", "extra", 2, 12)],
    lastDownloadByLineage: new Map([["extra", at(10)]]),
    names,
  });
  expect(replaced.files.map((f) => [f.name, f.badge])).toEqual([
    ["extra.pdf", "updated"],
  ]);
});
