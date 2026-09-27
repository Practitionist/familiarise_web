import { requireBackofficePage } from "@/lib/auth-guard";
import SettingsPageClient from "./SettingsPageClient";

/** The operator's own profile; every operator holds `users.read`. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("users.read", (await params).tree);
  return <SettingsPageClient />;
}
