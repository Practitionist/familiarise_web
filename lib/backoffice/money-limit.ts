import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";
import { OpsRefusal } from "./ops-refusal-error";

/** #677/PM-36 — the money doors share the per-admin money-ops throttle. */
export async function assertMoneyOpsBudget(userId: string): Promise<void> {
  if (await applyRateLimit(moneyOpsLimiter, userId)) {
    throw new OpsRefusal(
      "RATE_LIMITED",
      "Too many money actions in a minute — wait and try again.",
      429,
    );
  }
}
