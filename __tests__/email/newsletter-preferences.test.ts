/** @jest-environment node */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  findNewsletterPreferenceBlocks,
  type NewsletterPreferenceReader,
} from "@/lib/email/newsletter-preferences";

function reader(
  preferences: {
    marketingEmails: boolean;
    allNotifications: boolean;
    emailEnabled: boolean;
  } | null,
  erasedAt: Date | null = null,
) {
  const db: NewsletterPreferenceReader = {
    user: {
      findMany: jest.fn().mockResolvedValue([
        {
          email: "Reader@Example.com",
          erasedAt,
          notificationPreferences: preferences,
        },
      ]),
    },
  };
  return db;
}

const enabled = {
  marketingEmails: true,
  allNotifications: true,
  emailEnabled: true,
};

describe("newsletter account preferences", () => {
  it.each(["marketingEmails", "allNotifications", "emailEnabled"])(
    "blocks a matching account with %s off",
    async (field) => {
      const db = reader({ ...enabled, [field]: false });
      await expect(
        findNewsletterPreferenceBlocks([" READER@example.com "], db),
      ).resolves.toEqual(new Set(["reader@example.com"]));
      expect(db.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: { in: ["reader@example.com"], mode: "insensitive" } },
        }),
      );
    },
  );

  it("uses the displayed marketing-off default for an account without a preference row", async () => {
    await expect(
      findNewsletterPreferenceBlocks(["reader@example.com"], reader(null)),
    ).resolves.toEqual(new Set(["reader@example.com"]));
  });

  it("does not veto an enabled account or a subscriber without an account", async () => {
    await expect(
      findNewsletterPreferenceBlocks(
        ["reader@example.com", "external@example.com"],
        reader(enabled),
      ),
    ).resolves.toEqual(new Set());
  });

  it("blocks a matching erased account", async () => {
    await expect(
      findNewsletterPreferenceBlocks(
        ["reader@example.com"],
        reader(enabled, new Date()),
      ),
    ).resolves.toEqual(new Set(["reader@example.com"]));
  });

  it("propagates unavailable preference reads instead of authorizing a send", async () => {
    const db = reader(enabled);
    jest
      .mocked(db.user.findMany)
      .mockRejectedValue(new Error("database unavailable"));
    await expect(
      findNewsletterPreferenceBlocks(["reader@example.com"], db),
    ).rejects.toThrow("database unavailable");
  });
});
