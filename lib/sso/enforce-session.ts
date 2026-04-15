/**
 * Server-side SSO enforcement decision for BetterAuth `session.create.before`.
 *
 * Runs just before a session cookie is issued (every authenticated path —
 * credential signin, OAuth signin, SSO signin, signup). Returns whether the
 * session creation should be rejected and why. Pure helper — all I/O is
 * injected so this can be unit-tested without a live DB.
 *
 * See issue #673 for the specific bypass this closes.
 *
 * Fails OPEN in one case: the org has `enforceSSO=true` but has not yet
 * registered any `ssoProvider` rows. Locking everyone out mid-setup would
 * trap the org owner after they flip the switch but before they finish
 * adding an IdP.
 */

export type EnforceDecision =
  | { reject: false }
  | { reject: true; reason: "SSO_REQUIRED"; organizationId: string };

export interface EnforceInputs {
  /** Email of the user attempting to create a session (must already be lowercased). */
  email: string | null | undefined;
  /** The user ID — used to look up the user's linked accounts. */
  userId: string;
  /** Returns org id + allowed provider IDs for the enforcing org, or null if the domain is not enforced. */
  lookupEnforcedOrg: (domain: string) => Promise<{
    organizationId: string;
    registeredProviderIds: string[];
  } | null>;
  /** Returns true if the user has any `account` row whose `providerId` is in the given list. */
  hasAccountInProviders: (
    userId: string,
    providerIds: string[],
  ) => Promise<boolean>;
}

export async function shouldRejectSession(
  inputs: EnforceInputs,
): Promise<EnforceDecision> {
  const email = inputs.email?.toLowerCase();
  const domain = email?.split("@")[1];
  if (!domain) return { reject: false };

  const enforced = await inputs.lookupEnforcedOrg(domain);
  if (!enforced) return { reject: false };

  // Fail-open: org is enforced but has no providers configured yet.
  // Better to let the admin finish setup than to lock the whole domain out.
  if (enforced.registeredProviderIds.length === 0) return { reject: false };

  const linked = await inputs.hasAccountInProviders(
    inputs.userId,
    enforced.registeredProviderIds,
  );
  if (linked) return { reject: false };

  return {
    reject: true,
    reason: "SSO_REQUIRED",
    organizationId: enforced.organizationId,
  };
}
