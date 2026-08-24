/**
 * Shared keyset-paginated CSV export stream (#1230 wave-4b).
 *
 * Both statutory exporters (payouts, invoices) walk a table newest-first in
 * fixed-size chunks using (createdAt, id) keyset pagination and emit
 * RFC-4180-safe output. This module owns that machinery once so Sonar's
 * new-code duplication gate stays green and every future export inherits:
 *
 *   - pull-based backpressure (pages enqueue only when the client drains)
 *   - request-abort awareness (findMany chain stops on _req.signal)
 *   - bounded iterations with an explicit TRUNCATED marker row
 *   - generic in-band error notices; real errors logged server-side
 *   - RFC 4180 escaping and full-width single-cell notice rows
 */

export function escapeCsvField(v: string | number | null | undefined): string {
  if (v === "" || v === null || v === undefined) return "";
  const s = String(v);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export interface KeysetCsvOptions<TRow> {
  /** Column count — notice rows pad to this width for strict parsers. */
  columnCount: number;
  header: string;
  /** AbortSignal from the request; checked before every page fetch. */
  signal: AbortSignal;
  /**
   * Fetch one page older than `cursor`. Return `{ rows, nextCursor }`, or
   * `nextCursor: null` when the table is exhausted.
   */
  fetchPage: (cursor: {
    createdAt: Date;
    id: string;
  } | null) => Promise<{ rows: TRow[]; nextCursor: { createdAt: Date; id: string } | null }>;
  /** Convert one row to ordered CSV cells (pre-escaping). */
  rowToCells: (row: TRow) => Array<string | number | null | undefined>;
  /** Server-side sink for mid-stream failures (client only sees a notice). */
  onError?: (err: unknown, context: { iterations: number }) => void;
  chunkSize?: number;
  /** Iteration ceiling; default 400 × chunkSize = 200k rows. */
  maxIterations?: number;
}

export function keysetCsvStream<TRow>(
  opts: KeysetCsvOptions<TRow>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunkSize = opts.chunkSize ?? 500;
  const maxIterations = opts.maxIterations ?? 400;

  const noticeRow = (message: string): Uint8Array =>
    encoder.encode(
      [
        escapeCsvField(message),
        ...new Array(Math.max(0, opts.columnCount - 1)).fill(""),
      ].join(",") + "\n",
    );

  let cursor: { createdAt: Date; id: string } | null = null;
  let iterations = 0;
  let headerSent = false;
  let truncated = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(encoder.encode(opts.header));
      }
      // Abort or ceiling: close (with an honest marker when rows were left).
      if (opts.signal.aborted || iterations >= maxIterations) {
        controller.enqueue(noticeRow("TRUNCATED: row limit reached — re-export with a narrower period via the API."));
        controller.close();
        return;
      }
      iterations += 1;

      try {
        const page = await opts.fetchPage(cursor);
        if (page.rows.length === 0 || page.nextCursor === null) {
          controller.close();
          return;
        }
        const lines = page.rows.map((r) =>
          opts.rowToCells(r).map(escapeCsvField).join(","),
        );
        controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
        cursor = page.nextCursor;
        if (iterations >= maxIterations && page.rows.length === chunkSize) {
          truncated = true;
        }
      } catch (err) {
        opts.onError?.(err, { iterations });
        controller.enqueue(
          noticeRow("EXPORT ERROR: export failed mid-stream — contact support."),
        );
        controller.close();
      }
    },
  });
}

/** Convenience for callers building Prisma where-clauses from the cursor. */
export function keysetWhere<Base>(
  base: Base,
  cursor: { createdAt: Date; id: string } | null,
) {
  if (!cursor) return base;
  return {
    AND: [
      base,
      {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      },
    ],
  };
}
