import prisma from "@/lib/prisma";
import { deleteSubscriber } from "@/lib/novu/subscriber";
import { providerDomains } from "@/lib/sso/domains";
import { assertIdpClaims, decodeIdTokenClaims } from "@/lib/sso/idp-claims";
import { isSsoProviderId } from "@/lib/sso/account-domain";

const UNFINISHED_USER_WINDOW_MS = 5 * 60 * 1000;

/**
 * IdP claim checks on the id_token BetterAuth is about to store. Called from
 * `account.create.before` and `account.update.before`, which run inside the
 * OAuth user step before any session exists, so a refusal leaves the stored
 * link untouched and the sso plugin redirects to its error URL with the code.
 */
export async function assertSsoAccountClaims(account: {
  providerId: string;
  idToken?: string | null;
}): Promise<void> {
  const provider = await prisma.ssoProvider.findUnique({
    where: { providerId: account.providerId },
    select: { domain: true },
  });
  // An unknown provider is refused by the domain check that runs first.
  if (!provider) return;
  assertIdpClaims(
    decodeIdTokenClaims(account.idToken ?? undefined),
    providerDomains(provider.domain),
  );
}

/**
 * `account.update.before`: a returning SSO login always sends providerId and
 * omits idToken when the IdP did; token refreshes and password changes never
 * send providerId, so only sign-ins are checked and a missing token is refused.
 */
export async function assertSsoAccountUpdate(update: {
  providerId?: unknown;
  idToken?: unknown;
}): Promise<void> {
  if (typeof update.providerId !== "string") return;
  if (!isSsoProviderId(update.providerId)) return;
  await assertSsoAccountClaims({
    providerId: update.providerId,
    idToken: typeof update.idToken === "string" ? update.idToken : null,
  });
}

/**
 * Removes the user row this callback created when its first account is
 * refused (the adapter has no transactions). Only a user with no account, no
 * session and a creation time inside this request's window can match.
 */
export async function discardUnfinishedSsoUser(userId: string): Promise<void> {
  const { count } = await prisma.user.deleteMany({
    where: {
      id: userId,
      accounts: { none: {} },
      sessions: { none: {} },
      createdAt: { gt: new Date(Date.now() - UNFINISHED_USER_WINDOW_MS) },
    },
  });
  if (count === 1) await deleteSubscriber(userId);
}
