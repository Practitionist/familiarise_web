const findDomains = jest.fn();
const findTags = jest.fn();
const findSubDomains = jest.fn();
const revalidateTag = jest.fn();

jest.mock("next/cache", () => ({
  // Pass-through: the cache layer itself is Next's; we test our reader and purge.
  unstable_cache: <T extends (...a: never[]) => unknown>(fn: T) => fn,
  revalidateTag: (...args: unknown[]) => revalidateTag(...args),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    domain: { findMany: (...a: unknown[]) => findDomains(...a) },
    tag: { findMany: (...a: unknown[]) => findTags(...a) },
    subDomain: { findMany: (...a: unknown[]) => findSubDomains(...a) },
  },
}));

import {
  getDomainsWithChildren,
  getSubDomains,
  getTags,
  purgeTaxonomy,
} from "@/lib/data/taxonomy";

const d = (id: string) => ({ id, name: `d-${id}` });

describe("taxonomy cache reader", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reads domains in one join query with no Date columns", async () => {
    findDomains.mockResolvedValue([]);
    await getDomainsWithChildren();
    const args = findDomains.mock.calls[0][0];
    expect(args.relationLoadStrategy).toBe("join");
    expect(JSON.stringify(args.select)).not.toMatch(/createdAt|updatedAt/);
  });

  it("filters tags by domain in memory from one full read", async () => {
    findTags.mockResolvedValue([
      { id: "t1", name: "a", domainId: "x", domain: d("x") },
      { id: "t2", name: "b", domainId: "y", domain: d("y") },
    ]);
    expect(await getTags("y")).toEqual([
      { id: "t2", name: "b", domainId: "y", domain: d("y") },
    ]);
    expect(await getTags()).toHaveLength(2);
    expect(findTags.mock.calls[0][0].where).toBeUndefined();
  });

  it("filters sub-domains by domain", async () => {
    findSubDomains.mockResolvedValue([
      { id: "s1", name: "a", domainId: "x", domain: d("x") },
      { id: "s2", name: "b", domainId: "y", domain: d("y") },
    ]);
    expect(await getSubDomains("x")).toHaveLength(1);
  });

  it("purgeTaxonomy revalidates the taxonomy tag", () => {
    purgeTaxonomy();
    expect(revalidateTag).toHaveBeenCalledWith("taxonomy");
  });
});
