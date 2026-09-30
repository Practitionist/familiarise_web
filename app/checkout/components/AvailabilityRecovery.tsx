"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export function AvailabilityRecovery({
  href,
  notCharged,
}: {
  href: string;
  notCharged: boolean;
}) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-950"
    >
      <p className="font-medium">Please choose another time</p>
      <p className="mt-1 text-sm">
        This time is no longer available for checkout. Your plan choice is
        saved.
        {notCharged && " Your card has not been charged."}
      </p>
      <Button asChild variant="outline" className="mt-3 rounded-lg">
        <Link href={href}>Choose another time</Link>
      </Button>
    </div>
  );
}
