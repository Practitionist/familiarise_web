import type { PrismaLike } from "@/lib/prisma";

const HONORIFICS = new Set(["MR", "MRS", "MS", "DR"]);

/** Upper-cased words, punctuation and the MR/MRS/MS/DR honorifics dropped. */
export function normalisePersonName(name: string): string {
  return name
    .toUpperCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "" && !HONORIFICS.has(word))
    .join(" ");
}

/** A name missing on either side never matches. */
export function personNamesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const left = normalisePersonName(a);
  return left !== "" && left === normalisePersonName(b);
}

/** The bank-registered holder name on the consultant's verified payout account, default first. */
export async function verifiedPayoutHolderName(
  db: PrismaLike,
  consultantProfileId: string,
): Promise<string | null> {
  const account = await db.payoutAccount.findFirst({
    where: { consultantProfileId, isVerified: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    select: { accountHolderName: true },
  });
  return account?.accountHolderName ?? null;
}
