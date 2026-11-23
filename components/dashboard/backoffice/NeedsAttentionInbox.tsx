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
import type {
  AttentionItem,
  AttentionItems,
  AttentionQueue,
} from "@/lib/backoffice/needs-attention";

const MINUTE_MS = 60_000;

function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function limit(queue: AttentionQueue): string {
  if (queue.deadline) return "inside 48 h of the deadline";
  return queue.limitMs > 0 ? `older than ${age(queue.limitMs)}` : "at any age";
}

function due(ms: number, deadline: boolean): string {
  if (!deadline) return age(ms);
  return ms < 0 ? `due in ${age(-ms)}` : `overdue by ${age(ms)}`;
}

function shownSummary(items: AttentionItems | null): string | null {
  if (!items || items.total === 0) return null;
  if (items.newest.length === 0) return `${items.total} waiting.`;
  return `${items.total} waiting; showing the oldest ${items.oldest.length} and the newest ${items.newest.length}.`;
}

function QueueTable({
  queue,
  basePath,
}: Readonly<{ queue: AttentionQueue; basePath: string }>) {
  const items = queue.items;
  if (items === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Read failed. The other queues are unaffected.
      </p>
    );
  }
  if (items.oldest.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing is stuck.</p>;
  }
  const between = Math.max(
    0,
    items.total - items.oldest.length - items.newest.length,
  );
  const row = (item: AttentionItem) => (
    <ItemRow
      key={item.id}
      item={item}
      deadline={queue.deadline}
      basePath={basePath}
    />
  );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Item</TableHead>
          <TableHead>State</TableHead>
          <TableHead className="text-right">
            {queue.deadline ? "Deadline" : "Past due"}
          </TableHead>
          <TableHead className="text-right">Attempts</TableHead>
          <TableHead>Last error</TableHead>
          <TableHead>Open</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.oldest.map(row)}
        {between > 0 && (
          <TableRow>
            <TableCell
              colSpan={6}
              className="text-center text-xs text-muted-foreground"
            >
              {between} more in between
            </TableCell>
          </TableRow>
        )}
        {items.newest.map(row)}
      </TableBody>
    </Table>
  );
}

function ItemRow({
  item,
  deadline,
  basePath,
}: Readonly<{ item: AttentionItem; deadline: boolean; basePath: string }>) {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{item.id}</TableCell>
      <TableCell className="text-xs">{item.state}</TableCell>
      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {due(item.ageMs, deadline)}
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
            `Listed when ${limit(queue)}.`,
            queue.note,
            shownSummary(queue.items),
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
