/**
 * @jest-environment node
 */

// Storage's batch delete returns only the rows it removed, so an empty answer
// for a non-empty request must not read as success while the object survives.
const remove = jest.fn();
const exists = jest.fn();

jest.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ storage: { from: () => ({ remove, exists }) } }),
}));

import { deleteAsset } from "../../lib/supabase-storage-core";

beforeEach(() => {
  remove.mockReset();
  exists.mockReset();
});

describe("deleteAsset", () => {
  it("succeeds when storage reports the object removed", async () => {
    remove.mockResolvedValue({ data: [{ name: "a/b.pdf" }], error: null });
    await expect(deleteAsset("documents", "a/b.pdf")).resolves.toBe(true);
    expect(exists).not.toHaveBeenCalled();
  });

  it("fails when nothing was removed and the object still exists", async () => {
    remove.mockResolvedValue({ data: [], error: null });
    exists.mockResolvedValue({ data: true, error: null });
    await expect(deleteAsset("documents", "a/b.pdf")).resolves.toBe(false);
  });

  it("succeeds when nothing was removed because the object is already gone", async () => {
    remove.mockResolvedValue({ data: [], error: null });
    exists.mockResolvedValue({ data: false, error: { status: 404 } });
    await expect(deleteAsset("documents", "a/b.pdf")).resolves.toBe(true);
  });

  it("fails on a storage error or a thrown re-check", async () => {
    remove.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(deleteAsset("documents", "a/b.pdf")).resolves.toBe(false);

    remove.mockResolvedValueOnce({ data: [], error: null });
    exists.mockRejectedValueOnce(new Error("network"));
    await expect(deleteAsset("documents", "a/b.pdf")).resolves.toBe(false);
  });

  it("fails without a service-role key", async () => {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await jest.isolateModulesAsync(async () => {
        const core = await import("../../lib/supabase-storage-core");
        await expect(core.deleteAsset("documents", "a/b.pdf")).resolves.toBe(
          false,
        );
      });
      expect(remove).not.toHaveBeenCalled();
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    }
  });
});
