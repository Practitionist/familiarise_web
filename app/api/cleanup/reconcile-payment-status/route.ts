import { getCleanupJobHandlers } from "@/lib/cron/cleanup-registry";

export const { GET, POST } = getCleanupJobHandlers("reconcile-payment-status")!;
