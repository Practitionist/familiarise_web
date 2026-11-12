/**
 * @jest-environment node
 */

/**
 * Product-level guards: publish, settlement and file removal serialise on the
 * product row lock, a draft's category change must fit its files, a paid price clears
 * Razorpay's ₹1 floor (schema and CHECK), and public pages are purged only
 * after a committed flip or a committed edit of a published listing.
 */
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: { user: { id: "u_owner", consultantProfileId: "cp_owner" } },
  }),
  requireApiSession: async () => ({ error: true }),
}));
const revalidatePath = jest.fn();
let purgesAtCommit: number | null = null;
jest.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
  revalidateTag: jest.fn(),
}));
jest.mock("../../lib/storage/r2-client", () => ({
  deleteR2Object: async () => ({ success: true }),
}));
type Door = {
  run: (
    tx: unknown,
    ctx: { params: { id: string }; body: { reason: string } },
  ) => Promise<{ afterCommit?: () => unknown }>;
};
const mockDoors: Door[] = [];
jest.mock("../../lib/backoffice/ops-action-log", () => ({
  withOpsAction: (_p: string, _a: string, _o: object, door: Door) => {
    mockDoors.push(door);
    return jest.fn();
  },
}));

type Asset = { id: string; status: string; mimeType: string };
const state: { status: string; assets: Asset[]; sold: boolean } = {
  status: "DRAFT",
  assets: [],
  sold: false,
};
const product = () => ({
  id: "dp_1",
  consultantProfileId: "cp_owner",
  slug: "guide-1",
  status: state.status,
  category: "DOCUMENT",
  takenDownAt: null,
});

// The row lock: each transaction waits for the previous holder to finish.
let lockTail: Promise<void> = Promise.resolve();
let publishGate: Promise<void> | null = null;
const verified = (notId?: string) =>
  state.assets.filter((a) => a.status === "VERIFIED" && a.id !== notId).length;

function makeTx() {
  let release = () => {};
  const tx = {
    $executeRaw: async () => {
      const prev = lockTail;
      lockTail = new Promise((r) => (release = r));
      await prev;
    },
    digitalProduct: {
      findUnique: async () => ({ status: state.status }),
      findFirst: async () => (verified() > 0 ? { id: "dp_1" } : null),
      update: async ({ data }: { data: object }) => ({ id: "dp_1", ...data }),
      updateMany: async ({
        where,
      }: {
        where: { status: { in: string[] } };
      }) => {
        if (publishGate) await publishGate;
        if (!where.status.in.includes(state.status) || verified() === 0) {
          return { count: 0 };
        }
        state.status = "PUBLISHED";
        return { count: 1 };
      },
    },
    digitalProductPurchase: {
      findFirst: async () => (state.sold ? { id: "dpp_1" } : null),
    },
    digitalProductAsset: {
      count: async ({ where }: { where: { id: { not: string } } }) =>
        verified(where.id.not),
      findMany: async () =>
        state.assets.filter((a) => ["PENDING", "VERIFIED"].includes(a.status)),
      updateMany: async ({ where }: { where: { id: string } }) => {
        const asset = state.assets.find((a) => a.id === where.id);
        if (asset?.status !== "VERIFIED") return { count: 0 };
        asset.status = "SUPERSEDED";
        return { count: 1 };
      },
    },
  };
  return { tx, release: () => release() };
}

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => {
      const { tx, release } = makeTx();
      try {
        return await cb(tx);
      } finally {
        release();
      }
    },
    digitalProduct: {
      findFirst: async () => product(),
      update: async () => {
        purgesAtCommit = revalidatePath.mock.calls.length;
        return { id: "dp_1", status: state.status, updatedAt: new Date() };
      },
      updateMany: async () => {
        if (state.status === "ARCHIVED") return { count: 0 };
        state.status = "ARCHIVED";
        return { count: 1 };
      },
    },
    digitalProductAsset: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        const asset = state.assets.find((a) => a.id === where.id);
        return asset ? { ...asset, storageKey: "k" } : null;
      },
    },
  },
}));

import { POST as publishRoute } from "../../app/api/digital-products/[productId]/publish/route";
import { POST as archiveRoute } from "../../app/api/digital-products/[productId]/archive/route";
import { PATCH } from "../../app/api/digital-products/[productId]/route";
import { DELETE as removeFile } from "../../app/api/digital-products/[productId]/assets/[assetId]/route";
import { readSidecarMigrationSql } from "../../scripts/db/sidecar-objects";
import prisma from "../../lib/prisma";
import { lockDeliverableDigitalProduct } from "../../lib/digital-products/product-lock";
import { createDigitalProductSchema } from "../../schemas/digital-products";
import { DIGITAL_PRODUCT_MIN_PAID_PRICE_PAISE } from "../../lib/digital-products/constants";

const params = { params: Promise.resolve({ productId: "dp_1" }) };
const req = (body?: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    body: body === undefined ? null : JSON.stringify(body),
  });
const pdf = (id: string, status = "VERIFIED") => ({
  id,
  status,
  mimeType: "application/pdf",
});

beforeEach(() => {
  jest.clearAllMocks();
  publishGate = null;
  state.status = "DRAFT";
  state.assets = [pdf("as_1")];
  state.sold = false;
});

it("never leaves a published product without a file when publish and removal race", async () => {
  let open = () => {};
  publishGate = new Promise((r) => (open = r));
  const publishing = publishRoute(req(), params);
  await new Promise((r) => setImmediate(r));
  // The removal read DRAFT before publish committed, then waits on the lock.
  const removing = removeFile(req(), {
    params: Promise.resolve({ productId: "dp_1", assetId: "as_1" }),
  });
  await new Promise((r) => setImmediate(r));
  open();
  const [published, removed] = await Promise.all([publishing, removing]);

  expect(published.status).toBe(200);
  expect(removed.status).toBe(409);
  expect((await removed.json()).code).toBe("LAST_FILE");
  expect(state.status).toBe("PUBLISHED");
  expect(verified()).toBe(1);
  expect(revalidatePath).toHaveBeenCalledWith("/explore/experts/cp_owner");
  expect(revalidatePath).toHaveBeenCalledWith("/explore/products/guide-1");
});

it("keeps a sold product's last file even after it is archived", async () => {
  state.status = "ARCHIVED";
  state.sold = true;
  const removed = await removeFile(req(), {
    params: Promise.resolve({ productId: "dp_1", assetId: "as_1" }),
  });
  expect(removed.status).toBe(409);
  expect((await removed.json()).code).toBe("LAST_PURCHASED_FILE");
  // Still VERIFIED, so the buyer's download route keeps serving it.
  expect(state.assets[0].status).toBe("VERIFIED");
});

it("orders a settle and a last-file removal on the product row lock", async () => {
  state.status = "ARCHIVED";
  const file = {
    params: Promise.resolve({ productId: "dp_1", assetId: "as_1" }),
  };
  // A settle holding the lock commits SUCCEEDED first; the waiting removal then sees the sale.
  let commit = () => {};
  const settling = prisma.$transaction(async (tx) => {
    const ok = await lockDeliverableDigitalProduct(tx, "dp_1");
    await new Promise<void>((r) => (commit = r));
    state.sold = ok;
  });
  await new Promise((r) => setImmediate(r));
  const removing = removeFile(req(), file);
  await new Promise((r) => setImmediate(r));
  commit();
  await settling;
  const removed = await removing;
  expect(removed.status).toBe(409);
  expect((await removed.json()).code).toBe("LAST_PURCHASED_FILE");

  // The removal commits first; a later settle finds nothing deliverable under the lock.
  state.sold = false;
  process.env.R2_DIGITAL_PRODUCTS_BUCKET = "digital-products";
  expect((await removeFile(req(), file)).status).toBe(200);
  await expect(
    prisma.$transaction((tx) => lockDeliverableDigitalProduct(tx, "dp_1")),
  ).resolves.toBe(false);
});

it("refuses a draft category change its files do not fit", async () => {
  const misfit = await PATCH(req({ category: "AUDIO" }), params);
  expect(misfit.status).toBe(409);
  const body = await misfit.json();
  expect(body).toMatchObject({ code: "CATEGORY_MISMATCH", assetIds: ["as_1"] });
  expect(body.error).toMatch(/^The Audio category takes MP3, M4A, WAV files\./);

  state.assets = [pdf("as_1", "SUPERSEDED")];
  expect((await PATCH(req({ category: "AUDIO" }), params)).status).toBe(200);
});

it("prices a paid product at Razorpay's ₹1 floor or above", () => {
  const listing = {
    title: "Guide",
    description: "A useful guide.",
    category: "DOCUMENT",
  };
  const ok = (pricePaise: number) =>
    createDigitalProductSchema.safeParse({ ...listing, pricePaise }).success;
  expect([ok(0), ok(1), ok(99), ok(100)]).toEqual([true, false, false, true]);
  expect(readSidecarMigrationSql()).toContain(
    `CHECK ("pricePaise" = 0 OR "pricePaise" >= ${DIGITAL_PRODUCT_MIN_PAID_PRICE_PAISE})`,
  );
});

it("purges the public pages only after a committed takedown or archive", async () => {
  await import("../../app/api/admin/digital-products/[id]/takedown/route");
  const [door] = mockDoors;
  const ctx = { params: { id: "dp_1" }, body: { reason: "Breaks the rules" } };
  const tx = (count: number) => ({
    digitalProduct: {
      updateMany: async () => ({ count }),
      count: async () => 1,
      findUniqueOrThrow: async () => ({
        consultantProfileId: "cp_owner",
        slug: "guide-1",
      }),
    },
    digitalProductReport: { updateMany: async () => ({ count: 0 }) },
  });

  await expect(door.run(tx(0), ctx)).rejects.toMatchObject({
    code: "ALREADY_TAKEN_DOWN",
  });
  const result = await door.run(tx(1), ctx);
  expect(revalidatePath).not.toHaveBeenCalled();
  result.afterCommit?.();
  expect(revalidatePath).toHaveBeenCalledWith("/explore/products/guide-1");

  revalidatePath.mockClear();
  state.status = "ARCHIVED";
  expect((await archiveRoute(req(), params)).status).toBe(409);
  expect(revalidatePath).not.toHaveBeenCalled();
});

it("purges a published listing after its edit commits, and leaves a draft's alone", async () => {
  expect((await PATCH(req({ title: "New title" }), params)).status).toBe(200);
  expect(revalidatePath).not.toHaveBeenCalled();

  state.status = "PUBLISHED";
  expect((await PATCH(req({ pricePaise: 4900 }), params)).status).toBe(200);
  expect(purgesAtCommit).toBe(0);
  expect(revalidatePath).toHaveBeenCalledWith("/explore/products/guide-1");
  expect(revalidatePath).toHaveBeenCalledWith("/explore/experts/cp_owner");
});
