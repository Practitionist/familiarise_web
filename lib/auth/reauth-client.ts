import { z } from "zod";
import { fetchWithIdentity } from "@/lib/auth/identity-header";

/** Opens the re-auth dialog; resolves true once the user has re-authenticated. */
type ReauthHandler = () => Promise<boolean>;

let handler: ReauthHandler | null = null;

/** Called by <ReauthProvider> on mount and unmount. */
export function registerReauthHandler(next: ReauthHandler | null): void {
  handler = next;
}

function requestReauth(): Promise<boolean> {
  return handler ? handler() : Promise.resolve(false);
}

const reauthRequiredBody = z.object({ code: z.literal("REAUTH_REQUIRED") });

async function isReauthRequired(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null);
  return reauthRequiredBody.safeParse(body).success;
}

/**
 * `fetch` for step-up-gated routes, which are all money or IAM writes: sends
 * the expected user (fetchWithIdentity) and, on 403 REAUTH_REQUIRED, opens the
 * re-auth dialog and retries once. The body must be replayable (string/JSON).
 */
export async function fetchWithReauth(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetchWithIdentity(input, init);
  if (!(await isReauthRequired(res))) return res;
  if (!(await requestReauth())) return res;
  return fetchWithIdentity(input, init);
}

/** {@link fetchWithReauth} for BetterAuth client calls (`{ data, error }`). */
export async function withReauth<
  T extends { error?: { code?: string } | null },
>(call: () => Promise<T>): Promise<T> {
  const first = await call();
  if (first.error?.code !== "REAUTH_REQUIRED") return first;
  if (!(await requestReauth())) return first;
  return call();
}
