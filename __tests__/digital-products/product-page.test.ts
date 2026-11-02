/**
 * @jest-environment node
 */

/**
 * The product page and its metadata resolve the product through one viewer
 * lookup: an entitled buyer of an archived product gets its real title, and
 * anyone else hits notFound() before the page reads anything further.
 */
const mockViewer = { id: null as string | null };
const mockLookup = jest.fn();
const mockQuote = jest.fn();
const mockEntitlement = jest.fn();

jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/auth-server", () => ({
  getSession: async () =>
    mockViewer.id ? { user: { id: mockViewer.id } } : null,
}));
jest.mock("../../lib/data/digital-products-public", () => ({
  getDigitalProductForViewer: (...a: unknown[]) => mockLookup(...a),
}));
jest.mock("../../lib/payments/pricing/digital-product-price", () => ({
  quoteDigitalProductForBuyer: (...a: unknown[]) => mockQuote(...a),
}));
jest.mock("../../lib/payments/digital-product-entitlement", () => ({
  findDigitalProductEntitlement: (...a: unknown[]) => mockEntitlement(...a),
  findDigitalProductRefund: async (_db: unknown, _p: string, buyer: string) =>
    buyer === "refunded_1"
      ? { refundedAt: new Date("2026-11-02T09:00:00Z") }
      : null,
}));
jest.mock("../../app/explore/products/[slug]/ProductPurchasePanel", () => ({
  ProductPurchasePanel: function ProductPurchasePanel() {
    return null;
  },
}));
jest.mock("../../components/digital-products/ReportProductButton", () => ({
  ReportProductButton: () => null,
}));

import type { ReactElement, ReactNode } from "react";
import DigitalProductPage, {
  generateMetadata,
} from "../../app/explore/products/[slug]/page";

/** The props of the first element rendered by the named component. */
function propsOf(
  node: ReactNode,
  name: string,
): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child as ReactNode, name);
      if (found) return found;
    }
    return null;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "function" && el.type.name === name) {
    return el.props as Record<string, unknown>;
  }
  return propsOf(el.props?.children, name);
}

const archived = {
  id: "dp_1",
  pricePaise: 0,
  coverImagePath: null,
  category: "DOCUMENT",
  fileCount: 1,
  files: [],
  slug: "workbook-1a2b",
  title: "Workbook",
  subtitle: "Sub",
  description: "d",
  creator: { consultantProfileId: "cp_owner", name: "Hannah", headline: null },
};
const params = Promise.resolve({ slug: archived.slug });

beforeEach(() => {
  mockLookup.mockImplementation(async (_slug: string, viewerId: string) =>
    viewerId === "stranger" ? null : archived,
  );
});

it("titles an archived product for its buyer and hides it from everyone else", async () => {
  mockViewer.id = "buyer_1";
  await expect(generateMetadata({ params })).resolves.toMatchObject({
    title: "Workbook by Hannah — Familiarise",
  });
  expect(mockLookup).toHaveBeenCalledWith(archived.slug, "buyer_1");

  mockViewer.id = "stranger";
  await expect(generateMetadata({ params })).resolves.toEqual({
    title: "Product not found",
    robots: { index: false },
  });
  // notFound() fires before any per-viewer read or render.
  await expect(DigitalProductPage({ params })).rejects.toThrow(
    "NEXT_NOT_FOUND",
  );
  expect(mockEntitlement).not.toHaveBeenCalled();
  expect(mockQuote).not.toHaveBeenCalled();
});

it("tells a refunded buyer about the refund and still offers the product", async () => {
  mockViewer.id = "refunded_1";
  mockEntitlement.mockResolvedValue(null);
  const page = await DigitalProductPage({ params });
  expect(propsOf(page, "ProductPurchasePanel")).toMatchObject({
    viewer: { kind: "buyer", refundedAt: "2026-11-02T09:00:00.000Z" },
  });
});
