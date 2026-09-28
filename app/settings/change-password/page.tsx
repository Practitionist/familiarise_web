import { permanentRedirect } from "next/navigation";
import { requireAuth } from "@/lib/auth-guard";
import { accountSettingsHref } from "@/lib/dashboard/account-href";

/** Retired (#1527 §14): the password form lives in Settings › Account now. */
export default async function ChangePasswordRedirect() {
  const { user } = await requireAuth();
  permanentRedirect(accountSettingsHref(user) ?? "/dashboard");
}
