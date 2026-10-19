import { notFound } from "next/navigation";

import { requireBackofficePage } from "@/lib/auth-guard";
import { isBackofficeTree } from "@/lib/backoffice/capability";
import {
  DEFAULT_MONEY_OVERVIEW_DAYS,
  isMoneyOverviewDays,
  type MoneyOverviewDays,
} from "@/schemas/money-overview";
import { MoneyOverviewTab } from "@/components/dashboard/backoffice/money/MoneyOverviewTab";

/**
 * The Money group's landing page: "money in flight" for the operator.
 *
 * The page guard is the same one every other back-office page uses — the
 * tree decides the audience, the surface decides who may open it, and a
 * viewer who may not is redirected to the landing of their own tree rather
 * than to an error boundary.
 */
export default async function BackofficeMoneyOverviewPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ tree: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { tree } = await params;
  if (!isBackofficeTree(tree)) notFound();
  await requireBackofficePage("payments.read", tree);

  const query = await searchParams;
  const raw = query.days;
  const requested = typeof raw === "string" ? Number(raw) : null;
  const days: MoneyOverviewDays =
    requested !== null && isMoneyOverviewDays(requested)
      ? requested
      : DEFAULT_MONEY_OVERVIEW_DAYS;

  return <MoneyOverviewTab days={days} />;
}
