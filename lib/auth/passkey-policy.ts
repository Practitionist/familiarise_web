import type { GenericEndpointContext } from "better-auth";
import { APIError, getSessionFromCtx } from "better-auth/api";
import type { PasskeyOptions } from "@better-auth/passkey";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import { authUserFields } from "@/lib/auth/step-up";

const PASSKEY_OPERATORS_ONLY = {
  message:
    "Passkeys are available to staff who have set up an authenticator app.",
  code: "PASSKEY_OPERATORS_ONLY",
};

const USER_VERIFICATION_REQUIRED = {
  message: "Unlock your passkey with your device PIN or biometrics.",
  code: "PASSKEY_USER_VERIFICATION_REQUIRED",
};

function isEnrolledOperator(user: unknown): boolean {
  const parsed = authUserFields.safeParse(user);
  return (
    parsed.success &&
    isOperatorRole(parsed.data.role) &&
    parsed.data.twoFactorEnabled === true
  );
}

/**
 * `hooks.before` on passkey registration. TOTP stays the recovery factor, so
 * only an operator who has enrolled it may add a passkey, and registration
 * never mints a session.
 */
export async function assertOperatorMayRegisterPasskey(
  ctx: GenericEndpointContext,
): Promise<void> {
  if (
    ctx.path !== "/passkey/generate-register-options" &&
    ctx.path !== "/passkey/verify-registration"
  ) {
    return;
  }
  if (ctx.path === "/passkey/verify-registration" && ctx.body?.createSession) {
    throw new APIError("BAD_REQUEST", PASSKEY_OPERATORS_ONLY);
  }
  const current = await getSessionFromCtx(ctx);
  if (!isEnrolledOperator(current?.user)) {
    throw new APIError("FORBIDDEN", PASSKEY_OPERATORS_ONLY);
  }
}

/**
 * Plugin options for operator passkeys: the relying party is BETTER_AUTH_URL,
 * every ceremony must verify the user, and a passkey sign-in is refused once
 * its owner is no longer an enrolled operator.
 */
export function operatorPasskeyOptions(
  baseURL: string | undefined,
): PasskeyOptions {
  const origin = baseURL ? new URL(baseURL).origin : null;
  return {
    rpName: "Familiarise",
    rpID: origin ? new URL(origin).hostname : undefined,
    origin,
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    registration: {
      afterVerification: ({ verification }) => {
        if (!verification.registrationInfo?.userVerified) {
          throw new APIError("BAD_REQUEST", USER_VERIFICATION_REQUIRED);
        }
      },
    },
    authentication: {
      afterVerification: async ({ ctx, verification }) => {
        if (!verification.authenticationInfo.userVerified) {
          throw new APIError("UNAUTHORIZED", USER_VERIFICATION_REQUIRED);
        }
        const passkey = await ctx.context.adapter.findOne<{ userId: string }>({
          model: "passkey",
          where: [
            {
              field: "credentialID",
              value: verification.authenticationInfo.credentialID,
            },
          ],
        });
        const owner = passkey
          ? await ctx.context.internalAdapter.findUserById(passkey.userId)
          : null;
        if (!isEnrolledOperator(owner)) {
          throw new APIError("FORBIDDEN", PASSKEY_OPERATORS_ONLY);
        }
      },
    },
  };
}
