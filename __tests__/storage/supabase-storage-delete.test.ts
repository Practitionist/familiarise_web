/**
 * @jest-environment node
 */

/**
 * Deletes must run through the service client: the anon key is denied by
 * storage RLS without an error, so anon deletes report success and remove
 * nothing while the object stays public.
 */
describe("deleteAsset uses the service client", () => {
  const anonRemove = jest.fn(
    async (): Promise<{ error: { message: string } | null }> => ({
      error: null,
    }),
  );
  const adminRemove = jest.fn(
    async (): Promise<{ error: { message: string } | null }> => ({
      error: null,
    }),
  );
  let clientIndex = 0;

  beforeEach(async () => {
    jest.resetModules();
    anonRemove.mockReset().mockResolvedValue({ error: null });
    adminRemove.mockReset().mockResolvedValue({ error: null });
    clientIndex = 0;
    jest.doMock("@supabase/supabase-js", () => ({
      // First client constructed is anon, second is service-role.
      createClient: () => {
        clientIndex += 1;
        const remove = clientIndex === 1 ? anonRemove : adminRemove;
        return { storage: { from: () => ({ remove }) } };
      },
    }));
  });

  it("removes through the service-key client, not the anon one", async () => {
    const { deleteAsset } = await import("../../lib/supabase-storage-core");
    await expect(deleteAsset("b", "p")).resolves.toBe(true);
    expect(adminRemove).toHaveBeenCalledWith(["p"]);
    expect(anonRemove).not.toHaveBeenCalled();
  });

  it("returns false, never throws, when remove reports an error", async () => {
    adminRemove.mockResolvedValueOnce({ error: { message: "denied" } });
    const { deleteAsset } = await import("../../lib/supabase-storage-core");
    await expect(deleteAsset("b", "p")).resolves.toBe(false);
  });
});
