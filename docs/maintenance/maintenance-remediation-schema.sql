-- Schema-only rollout generated from the reviewed Prisma change. Apply only through the approved database procedure.
-- Apply before deploying readers; this artifact does not include or replace prisma/sql sidecars.

BEGIN;
SET LOCAL lock_timeout = '3s';

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "maintenanceChannelFrozenAt" TIMESTAMPTZ,
ADD COLUMN     "maintenanceChannelRecoveredAt" TIMESTAMPTZ,
ADD COLUMN     "maintenanceWindowId" TEXT;

-- AlterTable
ALTER TABLE "maintenance_windows" ADD COLUMN     "betterstackIncidentId" TEXT,
ADD COLUMN     "offlineActivatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MaintenanceRemediation" (
    "id" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "appointmentIds" TEXT[],
    "requestedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceRemediation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRemediationItem" (
    "id" TEXT NOT NULL,
    "remediationId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "MaintenanceRemediationItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaintenanceRemediation_windowId_createdAt_idx" ON "MaintenanceRemediation"("windowId", "createdAt");

-- CreateIndex
CREATE INDEX "MaintenanceRemediationItem_completedAt_attempts_id_idx" ON "MaintenanceRemediationItem"("completedAt", "attempts", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceRemediationItem_remediationId_appointmentId_key" ON "MaintenanceRemediationItem"("remediationId", "appointmentId");

-- CreateIndex
CREATE INDEX "Meeting_endedAt_idx" ON "Meeting"("endedAt");

-- CreateIndex
CREATE INDEX "Meeting_maintenanceWindowId_maintenanceChannelFrozenAt_ende_idx" ON "Meeting"("maintenanceWindowId", "maintenanceChannelFrozenAt", "endedAt");

-- CreateIndex
CREATE INDEX "Meeting_maintenanceWindowId_maintenanceChannelRecoveredAt_idx" ON "Meeting"("maintenanceWindowId", "maintenanceChannelRecoveredAt");

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_maintenanceWindowId_fkey" FOREIGN KEY ("maintenanceWindowId") REFERENCES "maintenance_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRemediation" ADD CONSTRAINT "MaintenanceRemediation_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "maintenance_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRemediationItem" ADD CONSTRAINT "MaintenanceRemediationItem_remediationId_fkey" FOREIGN KEY ("remediationId") REFERENCES "MaintenanceRemediation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;
