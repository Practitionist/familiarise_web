"use client";

import { useQuery } from "@tanstack/react-query";

import {
  cancelPreviewQueryKey,
  cancelPreviewUrl,
  cancelRefusalFrom,
  CancelRefusedError,
  shownQuoteBody,
} from "@/lib/appointments/cancel-requote";
import {
  CancelRefundPreviewSchema,
  type CancelRefundPreview,
} from "@/schemas/appointments";
import {
  STAFF_REFUND_PER_PAYMENT_PAISE,
  STAFF_REFUND_ROLLING_PAISE,
} from "@/lib/support/staff-refund-limits";
import { formatCurrencyAmount } from "@/utils/formatting";
import { DoorDialog } from "./DoorDialog";

/** The staff refund caps refuse with these codes; the copy names who can finish the cancel. */
export const PLATFORM_CANCEL_REFUSAL_COPY: Readonly<Record<string, string>> = {
  ADMIN_REQUIRED: `This cancel refunds more than ${formatCurrencyAmount(STAFF_REFUND_PER_PAYMENT_PAISE, "INR")} on one payment, which only an admin can send. Ask an admin to cancel it.`,
  STAFF_DAILY_LIMIT: `This refund would take you past the ${formatCurrencyAmount(STAFF_REFUND_ROLLING_PAISE, "INR")} staff refund limit for the last 24 hours. Ask an admin to cancel it.`,
  STAFF_REFUND_IN_PROGRESS:
    "Another refund of yours is still being sent. Try again in a moment.",
};

function RefundLine({
  preview,
}: Readonly<{
  preview: { isPending: boolean; data?: CancelRefundPreview; error: unknown };
}>) {
  if (preview.isPending)
    return (
      <p className="text-sm text-muted-foreground">Estimating the refund…</p>
    );
  if (preview.error instanceof CancelRefusedError)
    return <p className="text-sm text-destructive">{preview.error.message}</p>;
  const quote = preview.data;
  if (!quote)
    return (
      <p className="text-sm text-destructive">
        The refund could not be estimated, so this booking cannot be cancelled
        here yet.
      </p>
    );
  if (quote.paid === false)
    return <p className="text-sm">Nothing was paid, so nothing is refunded.</p>;
  const amount = formatCurrencyAmount(
    quote.estimatedRefundPaise,
    quote.currency,
  );
  return (
    <p className="text-sm">
      Refunds <span className="font-medium tabular-nums">{amount}</span>
      {quote.wholeEvent
        ? ` across ${quote.attendeeCount ?? 0} paid attendees.`
        : ` (${quote.refundPct}%).`}
      {quote.creditRestoresInFull ? " The credits come back in full." : ""}
    </p>
  );
}

/**
 * The platform cancel door for a whole booking: the refund it will send, a
 * reason and step-up. The door has no per-session scope.
 */
export function PlatformCancelDoor({
  appointmentId,
  open,
  invalidate,
  onClose,
}: Readonly<{
  appointmentId: string;
  open: boolean;
  invalidate: readonly (readonly unknown[])[];
  onClose: () => void;
}>) {
  const id = encodeURIComponent(appointmentId);
  const previewUrl = cancelPreviewUrl(id);
  const preview = useQuery<CancelRefundPreview>({
    queryKey: cancelPreviewQueryKey(previewUrl),
    queryFn: async () => {
      const res = await fetch(previewUrl, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        const refusal = cancelRefusalFrom(await res.json().catch(() => null));
        throw refusal ?? new Error("Could not estimate the refund");
      }
      const parsed = CancelRefundPreviewSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error("Could not estimate the refund");
      return parsed.data;
    },
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  if (!open) return null;
  const quote =
    preview.data && preview.data.paid !== false ? preview.data : undefined;
  return (
    <DoorDialog
      door={{
        url: `/api/staff/appointments/${id}/cancel`,
        title: "Cancel this booking",
        description:
          "Cancels the whole booking for everyone on it, not one session, and both parties are notified.",
        confirm: "Cancel booking",
        body: {
          cancellationReason: "OTHER",
          expectedRefundPaise: 0,
          ...shownQuoteBody(quote),
        },
      }}
      canConfirm={preview.isSuccess}
      refusalCopy={PLATFORM_CANCEL_REFUSAL_COPY}
      invalidate={[...invalidate, cancelPreviewQueryKey(previewUrl)]}
      onClose={onClose}
    >
      <RefundLine preview={preview} />
    </DoorDialog>
  );
}
