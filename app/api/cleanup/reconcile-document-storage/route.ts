/**
 * Document Storage Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-document-storage.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Daily (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { reconcileDocumentStorage } from "@/scripts/cleanup/reconcile-document-storage";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-document-storage",
  run: () => reconcileDocumentStorage(),
  summarize: (r) => ({
    orphanedFilesFound: r.orphanedFilesFound,
    orphanedFilesDeleted: r.orphanedFilesDeleted,
    missingFilesFound: r.missingFilesFound,
  }),
  // Return 207 if missing files found (needs attention)
  status: (r) => (r.missingFilesFound > 0 ? 207 : r.success ? 200 : 500),
  failureMessage: "Failed to reconcile document storage",
});
