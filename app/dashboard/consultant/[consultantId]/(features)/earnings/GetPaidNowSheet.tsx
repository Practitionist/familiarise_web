"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatInTimeZone } from "date-fns-tz";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { PAYOUT_ZONE } from "@/lib/dashboard/earnings-state";
import { formatCurrencyAmount } from "@/utils/formatting";

/**
 * #1771 row 6 — "Get paid now": free, once a day, READY earnings only. The
 * sheet shows the server's preview (READY total, TDS estimate, net) before the
 * expert confirms, and the toast says whether the money is on its way or
 * waiting for approval because it is above the instant cap.
 */

interface InstantPreview {
  readyPaise: number;
  tdsEstimatePaise: number;
  netPaise: number;
  label: string;
  nextAllowedAt: string | null;
  /** The first failing payout gate; the POST would refuse while it is set. */
  reason: string | null;
}

interface InstantOutcome {
  awaitingApproval: boolean;
}

const inr = (paise: number) => formatCurrencyAmount(paise, "INR");

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (body as { error?: string }).error ?? "Something went wrong",
    );
  }
  return body as T;
}

export function GetPaidNowSheet({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const preview = useQuery<InstantPreview>({
    queryKey: ["instant-payout-preview", consultantId],
    queryFn: async () =>
      readJson(await fetch("/api/consultant/payouts/instant/preview")),
    enabled: open,
    staleTime: 0,
  });

  const payNow = useMutation({
    mutationFn: async () =>
      readJson<InstantOutcome>(
        await fetch("/api/consultant/payouts/instant", { method: "POST" }),
      ),
    onSuccess: (outcome) => {
      setOpen(false);
      toast({
        title: outcome.awaitingApproval
          ? "Payout requested"
          : "Payout on its way",
        description: outcome.awaitingApproval
          ? "This amount needs a quick approval from our team before it is sent."
          : "Your available balance is being sent to your bank now.",
      });
      void queryClient.invalidateQueries({
        queryKey: ["consultant-earnings", consultantId],
      });
    },
    onError: (error) => {
      toast({
        title: "Could not pay you now",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    },
  });

  const data = preview.data;
  const usedToday = !!data?.nextAllowedAt;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline" className="w-full">
          Get paid now
        </Button>
      </SheetTrigger>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Get paid now</SheetTitle>
          <SheetDescription>
            {data?.label ?? "Free · once a day"}
          </SheetDescription>
        </SheetHeader>
        {data ? (
          <dl className="mt-6 space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Available</dt>
              <dd className="font-medium text-foreground">
                {inr(data.readyPaise)}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">TDS (estimate)</dt>
              <dd className="font-medium text-foreground">
                −{inr(data.tdsEstimatePaise)}
              </dd>
            </div>
            <div className="flex items-center justify-between border-t border-border pt-3">
              <dt className="font-medium text-foreground">To your bank</dt>
              <dd className="text-base font-semibold text-foreground">
                {inr(data.netPaise)}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">
            {preview.isError ? "Could not load the preview." : "Loading…"}
          </p>
        )}
        {usedToday && data?.nextAllowedAt && (
          <p className="mt-4 text-xs text-muted-foreground">
            You have used today&rsquo;s instant payout. The next one opens{" "}
            {formatInTimeZone(data.nextAllowedAt, PAYOUT_ZONE, "d MMM, h:mm a")}
            .
          </p>
        )}
        <Button
          className="mt-6 w-full"
          disabled={
            !data ||
            !!data.reason ||
            data.readyPaise <= 0 ||
            usedToday ||
            payNow.isPending
          }
          onClick={() => payNow.mutate()}
        >
          {payNow.isPending ? "Sending…" : "Pay me now"}
        </Button>
      </SheetContent>
    </Sheet>
  );
}
