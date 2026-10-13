const KEY = "auth:pending-verification-email";

/** Hands the address to /auth/verify-email without putting it in the URL. */
export function stashPendingVerificationEmail(email: string): void {
  try {
    sessionStorage.setItem(KEY, email);
  } catch {
    // Storage disabled: the verify page asks for the address instead.
  }
}

export function readPendingVerificationEmail(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearPendingVerificationEmail(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
