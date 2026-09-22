"use client";

import type { ReactNode } from "react";

import {
  INBOX_BUCKETS,
  type InboxBucket,
  type InboxRowInput,
} from "@/lib/dashboard/requests-inbox-state";

import { BUCKET_LABEL } from "./labels";

/**
 * Rows grouped under their deadline bucket, in bucket order, keeping the
 * read's sort inside each. A bucket with no rows does not render. A
 * flat list (`flat`) is for the Declined chip, where no clock applies.
 */
export function InboxBuckets({
  rows,
  flat,
  renderRow,
}: Readonly<{
  rows: InboxRowInput[];
  flat: boolean;
  renderRow: (row: InboxRowInput) => ReactNode;
}>) {
  if (flat) {
    return <ul className="divide-y divide-border">{rows.map(renderRow)}</ul>;
  }
  const groups = new Map<InboxBucket, InboxRowInput[]>();
  for (const row of rows) {
    groups.set(row.bucket, [...(groups.get(row.bucket) ?? []), row]);
  }
  return (
    <div className="space-y-6">
      {INBOX_BUCKETS.filter((bucket) => groups.has(bucket)).map((bucket) => {
        const { title, hint } = BUCKET_LABEL[bucket];
        const bucketRows = groups.get(bucket) ?? [];
        return (
          <section key={bucket} aria-labelledby={`inbox-bucket-${bucket}`}>
            <header className="flex items-baseline gap-2 px-3 pb-2 sm:px-4">
              <h3
                id={`inbox-bucket-${bucket}`}
                className="text-sm font-semibold text-foreground"
              >
                {title}
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  {bucketRows.length}
                </span>
              </h3>
              <p className="hidden text-xs text-muted-foreground sm:block">
                {hint}
              </p>
            </header>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {bucketRows.map(renderRow)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
