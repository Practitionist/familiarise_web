import Link from "next/link";

import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ATTENTION_ROW_CAP,
  type AttentionQueue,
} from "@/lib/backoffice/needs-attention";

const MINUTE_MS = 60_000;

function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function limit(ms: number): string {
  return ms === 0 ? "inside 48 h of the deadline" : `older than ${age(ms)}`;
}

function QueueTable({
  queue,
  basePath,
}: Readonly<{ queue: AttentionQueue; basePath: string }>) {
  if (queue.items === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Read failed. The other queues are unaffected.
      </p>
    );
  }
  if (queue.items.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing is stuck.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Item</TableHead>
          <TableHead>State</TableHead>
          <TableHead className="text-right">Past due</TableHead>
          <TableHead className="text-right">Attempts</TableHead>
          <TableHead>Last error</TableHead>
          <TableHead>Open</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {queue.items.map((item) => (
          <TableRow key={item.id}>
            <TableCell className="font-mono text-xs">{item.id}</TableCell>
            <TableCell className="text-xs">{item.state}</TableCell>
            <TableCell className="whitespace-nowrap text-right tabular-nums">
              {age(item.ageMs)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {item.attempts ?? "—"}
            </TableCell>
            <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
              {item.lastError ?? "—"}
            </TableCell>
            <TableCell className="space-x-3 whitespace-nowrap text-xs">
              {item.links.map((link) => (
                <Link
                  key={link.path}
                  href={`${basePath}/${link.path}`}
                  className="underline underline-offset-2"
                >
                  {link.label}
                </Link>
              ))}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** One section per watched queue; read-only, every action lives on the linked page. */
export function NeedsAttentionInbox({
  queues,
  basePath,
}: Readonly<{ queues: AttentionQueue[]; basePath: string }>) {
  return (
    <div className="space-y-4">
      {queues.map((queue) => (
        <Section
          key={queue.key}
          variant="card"
          title={queue.label}
          description={[
            `Listed when ${limit(queue.limitMs)}.`,
            queue.note,
            queue.capped
              ? `Showing the oldest ${ATTENTION_ROW_CAP}; more are waiting.`
              : null,
          ]
            .filter(Boolean)
            .join(" ")}
          actions={
            queue.money ? (
              <StatusBadge label="Money" tone="caution" variant="dot" />
            ) : undefined
          }
        >
          <QueueTable queue={queue} basePath={basePath} />
        </Section>
      ))}
    </div>
  );
}
