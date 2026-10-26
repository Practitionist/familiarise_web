-- Exact legacy approved-unallocated selector, aggregated without staging refunds.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';

WITH eligible AS (
  SELECT p."isMockPayment", p."paymentGateway", p."gatewayPaymentId"
  FROM "Payment" p
  JOIN "Appointment" a ON a.id = p."appointmentId"
  JOIN "Subscription" request ON request.id = a."subscriptionId"
  WHERE request."requestStatus" = 'EXPIRED'
    AND p."paymentStatus" = 'SUCCEEDED'
    AND p."deletedAt" IS NULL
    AND p."refundOwedKey" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "Refund" prior
      WHERE prior."dedupeKey" = 'approved-unallocated:' || p.id
        AND prior.status IN ('SUCCEEDED', 'PENDING')
    )
    AND GREATEST(0, p.amount - COALESCE((
      SELECT SUM(r."amountPaise") FROM "Refund" r
      WHERE r."paymentId" = p.id
        AND r.status::text IN ('SUCCEEDED', 'PENDING')
    ), 0) - COALESCE((
      SELECT SUM(d."amountPaise") FROM "Dispute" d
      WHERE d."paymentId" = p.id
        AND d.status::text IN ('LOST', 'CHARGE_REFUNDED')
    ), 0)) > 0
    AND EXISTS (
      SELECT 1 FROM "BookingStatusHistory" h
      WHERE h."entityId" = request.id
        AND h.entity = 'SUBSCRIPTION'
        AND h."fromStatus" = 'APPROVED'
        AND h."toStatus" = 'EXPIRED'
        AND h."actorUserId" IS NULL
        AND h.reason = 'Auto-expired: APPROVED with zero allocated sessions for more than 30 days'
    )
)
SELECT "paymentGateway", "isMockPayment", count(*) AS eligible_payment_count,
       count(*) FILTER (WHERE "gatewayPaymentId" IS NULL) AS missing_gateway_payment_id_count
FROM eligible
GROUP BY "paymentGateway", "isMockPayment"
ORDER BY "paymentGateway", "isMockPayment";

COMMIT;
