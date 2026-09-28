import { Section } from "@/components/dashboard/Section";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getOrgSponsoredGroupSeats } from "@/lib/data/org-sponsored-seats";

const SHOWN = 20;

/**
 * #1852 decision 3 — the group sessions this org's members attend elsewhere
 * on this org's money. One row per seat: the member, the session title, the
 * date and whether they attended. Other attendees and the host stay out of
 * view by construction (the read selects nothing else).
 */
export async function SponsoredSeatsSection({
  orgId,
}: Readonly<{ orgId: string }>) {
  const { items, total } = await getOrgSponsoredGroupSeats(orgId, {
    perPage: SHOWN,
  });
  if (total === 0) return null;

  return (
    <Section
      title="Group sessions elsewhere"
      description={
        total > SHOWN
          ? `Webinars and classes hosted by others that your members attend on your organisation's money. Showing the latest ${SHOWN} of ${total}.`
          : "Webinars and classes hosted by others that your members attend on your organisation's money."
      }
      variant="card"
      className="mt-6"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Session</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Attended</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((seat) => (
            <TableRow key={seat.id}>
              <TableCell>
                <div className="flex flex-col">
                  <span className="font-medium text-foreground">
                    {seat.member.name ?? seat.member.email}
                  </span>
                  {seat.member.name && (
                    <span className="text-xs text-muted-foreground">
                      {seat.member.email}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell>{seat.sessionTitle}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {seat.startsAt
                  ? new Date(seat.startsAt).toLocaleDateString("en-IN", {
                      dateStyle: "medium",
                    })
                  : "Not scheduled"}
              </TableCell>
              <TableCell>{seat.attended ? "Yes" : "No"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}
