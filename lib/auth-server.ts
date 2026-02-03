import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export async function getSession(disableCookieCache = false) {
  return auth.api.getSession({
    headers: await headers(),
    ...(disableCookieCache && { query: { disableCookieCache: true } }),
  });
}
