import Link from "next/link";
import { Button } from "@/components/ui/button";

/** A released seat's plain page: where the booking went, and a way to find another event. */
export function NoLongerRegistered({
  consulteeId,
}: Readonly<{ consulteeId: string }>) {
  return (
    <div className="mx-auto max-w-md space-y-3 rounded-2xl border border-border bg-card p-6 text-center">
      <h1 className="text-lg font-semibold text-foreground">
        You are no longer registered for this event
      </h1>
      <p className="text-sm text-muted-foreground">
        Your place was released. The booking is listed under Cancelled in your
        appointments.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link
            href={`/dashboard/consultee/${consulteeId}/appointments?tab=cancelled`}
          >
            Go to Appointments
          </Link>
        </Button>
        <Button asChild size="sm">
          <Link href="/explore/programs">Browse events</Link>
        </Button>
      </div>
    </div>
  );
}
