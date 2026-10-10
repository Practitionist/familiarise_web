/**
 * Defence in depth for a tab whose page was rendered for one account while
 * the cookie now carries another (a sign-in as someone else in another tab).
 * Money and IAM writes name the user the page belongs to; the server guard
 * (`requireApiAuth({ expectUser: true })`) answers 409 `IDENTITY_CHANGED` on
 * a mismatch, and the tab reloads as the account it really holds.
 */

export const EXPECTED_USER_HEADER = "x-expected-user";

let expectedUserId: string | null = null;

/** Set once per page load by AuthSyncProvider, from an effect. */
export function setExpectedUser(userId: string | null): void {
  expectedUserId = userId;
}

/** `fetch` for money and IAM writes: sends the expected user, reloads on 409. */
export async function fetchWithIdentity(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (expectedUserId) headers.set(EXPECTED_USER_HEADER, expectedUserId);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 409 && (await isIdentityChanged(res))) {
    window.location.reload();
  }
  return res;
}

async function isIdentityChanged(res: Response): Promise<boolean> {
  try {
    const body: unknown = await res.clone().json();
    return (
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      body.code === "IDENTITY_CHANGED"
    );
  } catch {
    return false;
  }
}
