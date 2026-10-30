/**
 * @jest-environment node
 */

/**
 * The digital product receipt is rendered before the settling transaction,
 * staged through the outbox on that transaction at most once per purchase,
 * and links to the buyer's library, never to a file.
 */

const mockStage = jest.fn();
const mockClaims: string[] = [];

jest.mock("../../lib/email/deliver", () => ({
  deliver: jest.fn(),
  stage: (...args: unknown[]) => mockStage(...args),
  attempt: jest.fn(),
}));
// react-email's node render needs a dynamic import jest cannot service.
jest.mock("../../lib/email/render", () => ({
  renderEmail: async (element: import("react").ReactElement) => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(element);
    return { html, text: html };
  },
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    user: {
      findMany: async () => [
        {
          id: "buyer_1",
          email: "buyer_1@example.com",
          name: "Asha",
          timezone: "Asia/Kolkata",
          notificationPreferences: null,
        },
      ],
    },
    idempotencyRecord: {
      findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
        where.key.in
          .filter((key) => mockClaims.includes(key))
          .map(() => ({ userId: "buyer_1" })),
      // skipDuplicates: an existing claim is not returned.
      createManyAndReturn: async ({ data }: { data: { key: string }[] }) => {
        const fresh = data.filter((d) => !mockClaims.includes(d.key));
        mockClaims.push(...fresh.map((d) => d.key));
        return fresh.map(() => ({ userId: "buyer_1" }));
      },
    },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  };
  return { __esModule: true, default: db };
});
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import prisma from "@/lib/prisma";
import {
  prepareDigitalProductPurchaseEmail,
  stageDigitalProductPurchaseEmail,
} from "@/lib/email/senders/money";

it("stages one receipt per purchase, linking the library and no file", async () => {
  mockStage.mockResolvedValue({ id: "fe_1", idempotencyKey: "k" });
  const args = {
    purchaseId: "dpp_1",
    buyerId: "buyer_1",
    productTitle: "Interview workbook",
    creatorName: "Ravi",
    amountPaise: 49_900,
    libraryHref: "/dashboard/go/client/products",
  };

  const receipt = await prepareDigitalProductPurchaseEmail(args);
  const first = await stageDigitalProductPurchaseEmail(prisma, receipt);
  expect(first).toHaveLength(1);
  const [message, emailType, opts] = mockStage.mock.calls[0];
  expect(emailType).toBe("DIGITAL_PRODUCT_PURCHASED");
  expect(opts).toMatchObject({
    entityRef: "digital-product-purchase:dpp_1",
    tx: prisma,
  });
  expect(message.subject).toBe("Your purchase: Interview workbook");
  expect(message.html).toContain("/dashboard/go/client/products");
  expect(message.html).toContain("₹499.00");
  expect(message.html).not.toContain("/download");

  // A re-run of the capture or claim stages nothing.
  expect(await stageDigitalProductPurchaseEmail(prisma, receipt)).toEqual([]);
  expect(mockStage).toHaveBeenCalledTimes(1);
});
