import { ModerationPage } from "@/components/dashboard/shared/ModerationPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** Content moderation, for both trees; see the component. */
export default async function BackofficeModerationPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("moderation.manage", (await params).tree);
  return <ModerationPage />;
}
