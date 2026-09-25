"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RefundDoorDialog, type RefundDoor } from "./RefundDoorDialog";

interface NeedsHuman {
  id: string;
  message: string;
  createdAt: string;
  paymentId: string | null;
}

async function fetchNeeds(): Promise<{ items: NeedsHuman[] }> {
  const res = await fetch("/api/admin/refunds/needs-human");
  if (!res.ok) throw new Error("Failed to load");
  return res.json() as Promise<{ items: NeedsHuman[] }>;
}

/**
 * #1771 K-5 — the admin half of the Refunds tab: the three refund doors and
 * the credit seats the automatic paths left for a human.
 */
export function RefundDoorsPanel() {
  const [open, setOpen] = useState<{
    door: RefundDoor;
    paymentId?: string;
  } | null>(null);
  const { data } = useQuery({
    queryKey: ["money-refund-needs"],
    queryFn: fetchNeeds,
    staleTime: 30_000,
  });
  const items = data?.items ?? [];

  return (
    <Card className="mx-4 mt-4 md:mx-6 lg:mx-8">
      <CardHeader>
        <CardTitle className="text-lg">Refund doors</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setOpen({ door: "issue" })}>
            Issue refund
          </Button>
          <Button
            variant="outline"
            onClick={() => setOpen({ door: "override" })}
          >
            Ladder override
          </Button>
          <Button
            variant="outline"
            onClick={() => setOpen({ door: "credits" })}
          >
            Return sessions of credits
          </Button>
        </div>
        {items.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              Credit seats waiting for a partial return
            </p>
            <ul className="divide-y divide-border rounded-md border">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
                >
                  <span className="min-w-0 flex-1">{item.message}</span>
                  {item.paymentId && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setOpen({
                          door: "credits",
                          paymentId: item.paymentId ?? undefined,
                        })
                      }
                    >
                      Return credits
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      <RefundDoorDialog
        key={`${open?.door}-${open?.paymentId ?? ""}`}
        door={open?.door ?? null}
        presetPaymentId={open?.paymentId}
        onClose={() => setOpen(null)}
      />
    </Card>
  );
}
