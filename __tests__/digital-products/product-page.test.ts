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
  findDigitalProductRefund: async () => null,
}));
jest.mock("../../app/explore/products/[slug]/ProductPurchasePanel", () => ({
  ProductPurchasePanel: () => null,
}));
jest.mock("../../components/digital-products/ReportProductButton", () => ({
  ReportProductButton: () => null,
}));

import DigitalProductPage, {
  generateMetadata,
} from "../../app/explore/products/[slug]/page";

const archived = {
  id: "dp_1",
  slug: "workbook-1a2b",
  title: "Workbook",
  subtitle: "Sub",
  description: "d",
  creator: { consultantProfileId: "cp_owner", name: "Hannah", headline: null },
};
const params = Promise.resolve({ slug: archived.slug });

beforeEach(() => {
  mockLookup.mockImplementation(async (_slug: string, viewerId: string) =>
    viewerId === "buyer_1" ? archived : null,
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
