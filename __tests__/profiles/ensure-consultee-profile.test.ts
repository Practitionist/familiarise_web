/**
 * @jest-environment node
 */
import type { PrismaLike } from "@/lib/prisma";
import { ensureConsulteeProfile } from "@/lib/profiles/ensure-consultee-profile";

function fakeDb(
  row: { id: string; user: { consulteeProfileId: string | null } } | null,
) {
  const db = {
    consulteeProfile: {
      findUnique: jest.fn(async () => row),
      upsert: jest.fn(async () => ({ id: row?.id ?? "cp_new" })),
    },
    user: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  return { db, client: db as unknown as PrismaLike };
}

describe("ensureConsulteeProfile", () => {
  it("returns a linked profile from one joined read and writes nothing", async () => {
    const { db, client } = fakeDb({
      id: "cp_1",
      user: { consulteeProfileId: "cp_1" },
    });
    await expect(ensureConsulteeProfile(client, "u_1")).resolves.toBe("cp_1");
    expect(db.consulteeProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: "u_1" },
      relationLoadStrategy: "join",
      select: { id: true, user: { select: { consulteeProfileId: true } } },
    });
    expect(db.consulteeProfile.upsert).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["no profile yet", null],
    [
      "a profile the user row does not link",
      { id: "cp_1", user: { consulteeProfileId: null } },
    ],
  ])("creates or links on %s", async (_case, row) => {
    const { db, client } = fakeDb(row);
    const id = await ensureConsulteeProfile(client, "u_1");
    expect(db.consulteeProfile.upsert).toHaveBeenCalledTimes(1);
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u_1", consulteeProfileId: null },
      data: { consulteeProfileId: id },
    });
  });
});
