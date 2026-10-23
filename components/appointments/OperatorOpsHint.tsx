import Link from "next/link";

/** The row-menu form of the hint below. */
export const OPS_HINT_LABEL = "Reschedule or cancel from the back office";

/** Stands in for a participant's Reschedule and Cancel when an operator who is not a party is looking. */
export function OperatorOpsHint({ href }: Readonly<{ href: string }>) {
  return (
    <p className="text-sm text-muted-foreground">
      You are not on this booking. Reschedule or cancel it from its{" "}
      <Link href={href} className="font-medium text-foreground underline">
        Ops panel
      </Link>{" "}
      in the back office.
    </p>
  );
}
