-- Documents, materials, recordings, digital products and meeting/video settings.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- One version number per position within a live document thread.
DROP INDEX IF EXISTS "appointment_doc_thread_version_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_doc_thread_version_unique"
ON "AppointmentDocument" (COALESCE("rootDocumentId", "id"), "versionNo")
WHERE "deletedAt" IS NULL;

-- Allowed keys mirror lib/stream/video-quality.ts.
ALTER TABLE "PlatformVideoConfig" DROP CONSTRAINT IF EXISTS "platform_video_config_values";
ALTER TABLE "PlatformVideoConfig" ADD CONSTRAINT "platform_video_config_values"
  CHECK (
    "callTargetResolution" IN ('480p', '720p', '1080p')
    AND "recordingQuality" IN ('720p', '1080p')
    AND "screenshareTargetResolution" IN ('720p', '1080p')
  );

CREATE UNIQUE INDEX IF NOT EXISTS "Recording_streamRecordingId_unique_idx"
  ON "Recording" ("streamRecordingId")
  WHERE "streamRecordingId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "AppointmentDocument_active_storagePath_key"
  ON "AppointmentDocument" ("storagePath")
  WHERE "deletedAt" IS NULL;

ALTER TABLE "AppointmentDocument" DROP CONSTRAINT IF EXISTS "AppointmentDocument_fileSize_positive_check";
ALTER TABLE "AppointmentDocument" ADD CONSTRAINT "AppointmentDocument_fileSize_positive_check"
  CHECK ("fileSize" > 0 AND "versionNo" >= 1);
-- A plan material belongs to exactly one plan.
ALTER TABLE "PlanMaterial" DROP CONSTRAINT IF EXISTS "PlanMaterial_single_plan_fk_check";
ALTER TABLE "PlanMaterial" ADD CONSTRAINT "PlanMaterial_single_plan_fk_check"
  CHECK (num_nonnulls("consultationPlanId", "subscriptionPlanId", "webinarPlanId", "classPlanId") = 1 AND "fileSize" > 0);

ALTER TABLE "Recording" DROP CONSTRAINT IF EXISTS "Recording_storage_and_publish_check";
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_storage_and_publish_check"
  CHECK (
    (
      "storageType" = 'PLATFORM'
      AND ("status" = 'EXPIRED' OR "storagePath" IS NOT NULL)
      AND (
        "listingStatus" <> 'PUBLISHED'
        OR (
          "storagePath" IS NOT NULL
          AND "listPricePaise" IS NOT NULL
          AND "listPricePaise" > 0
          AND "consentAttestedAt" IS NOT NULL
          AND "consentAttestedById" IS NOT NULL
        )
      )
    )
    OR (
      "storageType" <> 'PLATFORM'
      AND "status" <> 'AVAILABLE'
      AND "listingStatus" <> 'PUBLISHED'
    )
  ) NOT VALID;
ALTER TABLE "Recording" VALIDATE CONSTRAINT "Recording_storage_and_publish_check";

-- An erasure retry reads its user from the request; every other revocation kind names the user itself.
ALTER TABLE "StreamRevocationRetry" DROP CONSTRAINT IF EXISTS "stream_revocation_retry_owner";
ALTER TABLE "StreamRevocationRetry" ADD CONSTRAINT "stream_revocation_retry_owner"
  CHECK (("kind" = 'ERASURE_REVOKE') = ("erasureRequestId" IS NOT NULL)
    AND ("erasureRequestId" IS NOT NULL OR "userId" IS NOT NULL)
    AND ("kind" = 'DM_REMOVE') = ("counterpartUserId" IS NOT NULL));

-- One open retry per revocation target; a settled row frees the key for the next revocation.
CREATE UNIQUE INDEX IF NOT EXISTS "stream_revocation_retry_open_key"
  ON "StreamRevocationRetry" ("kind", "planId", "userId")
  WHERE "erasureRequestId" IS NULL AND "status" <> 'SUCCEEDED';

-- Meeting.endedReason holds only MEETING_END_REASONS (lib/meetings/end-reasons.ts).
ALTER TABLE "Meeting"
  DROP CONSTRAINT IF EXISTS "meeting_ended_reason_known",
  ADD CONSTRAINT "meeting_ended_reason_known"
    CHECK (
      "endedReason" IS NULL
      OR "endedReason" IN (
        'call_ended', 'maintenance', 'org_deactivated', 'org_deleted',
        'session_timeout', 'ended_early', 'stream_ended',
        'reconciled', 'reconciled_no_end', 'stream_not_found', 'stream_not_configured'
      )
    ) NOT VALID;
ALTER TABLE "Meeting" VALIDATE CONSTRAINT "meeting_ended_reason_known";

-- One live entitlement per buyer and product; failed and refunded attempts stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS "digital_product_purchase_succeeded_key"
  ON "DigitalProductPurchase" ("productId", "buyerId")
  WHERE "status" = 'SUCCEEDED';

ALTER TABLE "DigitalProduct" DROP CONSTRAINT IF EXISTS "digital_product_price_free_or_min_paid";
ALTER TABLE "DigitalProduct" ADD CONSTRAINT "digital_product_price_free_or_min_paid"
  CHECK ("pricePaise" = 0 OR "pricePaise" >= 100);

-- A free claim has no gateway order and a paid purchase always has one.
ALTER TABLE "DigitalProductPurchase" DROP CONSTRAINT IF EXISTS "digital_product_purchase_free_has_no_order";
ALTER TABLE "DigitalProductPurchase" ADD CONSTRAINT "digital_product_purchase_free_has_no_order"
  CHECK ("amountPaise" >= 0 AND ("amountPaise" = 0) = ("gatewayOrderId" IS NULL));

-- 250 MB per file (DIGITAL_PRODUCT_MAX_FILE_BYTES in lib/digital-products/constants.ts).
ALTER TABLE "DigitalProductAsset" DROP CONSTRAINT IF EXISTS "digital_product_asset_size_cap";
ALTER TABLE "DigitalProductAsset" ADD CONSTRAINT "digital_product_asset_size_cap"
  CHECK ("sizeBytes" >= 0 AND "sizeBytes" <= 262144000);

-- At most one current version per file lineage; verification retires the old one first.
CREATE UNIQUE INDEX IF NOT EXISTS "digital_product_asset_one_verified_per_lineage"
  ON "DigitalProductAsset" ("lineageId")
  WHERE "status" = 'VERIFIED';

COMMIT;
