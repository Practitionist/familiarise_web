/** A `prisma.dispute.groupBy` double over fixture rows: the urgent banner's status, gateway and due-date filters. */
type DisputeRow = { status: string; paymentGateway: string; dueBy: Date };
type GroupArgs = {
  where: {
    status?: { in: string[] };
    dueBy: { lt?: Date; gte?: Date; lte?: Date };
  };
};

export function disputeGroupBy(rows: DisputeRow[]) {
  return async ({ where }: GroupArgs) => {
    const { lt, gte, lte } = where.dueBy;
    const counts = new Map<string, number>();
    for (const row of rows) {
      const t = row.dueBy.getTime();
      if (where.status && !where.status.in.includes(row.status)) continue;
      if (lt && t >= lt.getTime()) continue;
      if (gte && t < gte.getTime()) continue;
      if (lte && t > lte.getTime()) continue;
      const key = `${row.status}|${row.paymentGateway}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].map(([key, all]) => {
      const [status, paymentGateway] = key.split("|");
      return { status, paymentGateway, _count: { _all: all } };
    });
  };
}
