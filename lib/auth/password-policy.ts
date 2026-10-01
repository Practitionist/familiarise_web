import { haveIBeenPwned } from "better-auth/plugins";

/**
 * Rejects passwords that appear in the Have I Been Pwned corpus wherever one is
 * a user chooses one: sign-up, reset and change. The admin create-user path is
 * left out on purpose: staff are created with a random 32-byte password nobody
 * sees, so checking it would only make onboarding depend on the range API.
 * Only the first five hex characters of the password's SHA-1 leave the server
 * (the k-anonymity range API).
 *
 * The plugin fails closed: if the range API cannot be reached the request
 * errors rather than accepting an unchecked password.
 *
 * The UI never shows this message (lib/labels renders PASSWORD_COMPROMISED);
 * it is for API clients.
 */
export const breachedPasswordCheck = haveIBeenPwned({
  paths: ["/sign-up/email", "/change-password", "/reset-password"],
  customPasswordCompromisedMessage:
    "This password has appeared in a data breach. Choose a different password.",
});
