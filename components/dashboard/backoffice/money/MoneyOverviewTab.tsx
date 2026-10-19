import { moneyOverviewSchema } from "@/schemas/money-overview";
import {
  DEFAULT_MONEY_OVERVIEW_DAYS,
  type MoneyOverviewDays,
} from "@/schemas/money-overview";
import { readMoneyOverview } from "@/lib/backoffice/money-overview";
import { MoneyOverview } from "./MoneyOverview";

/**
 * The server half of the Money overview: one read of the read model, parsed
 * against its wire contract, handed to the client component.
 *
 * Both entry points — `/money/overview` and the Money group's own tab route
 * — render this, so there is one implementation of the page.
 */
export async function MoneyOverviewTab({
  days = DEFAULT_MONEY_OVERVIEW_DAYS,
}: Readonly<{ days?: MoneyOverviewDays }>) {
  const overview = moneyOverviewSchema.parse(await readMoneyOverview({ days }));
  return <MoneyOverview overview={overview} />;
}
