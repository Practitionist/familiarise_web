/** #1771 K-9 — one audit row as the Audit tab and its API twin return it. */
export interface OpsLogRow {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorName: string | null;
  actorRole: string;
  surface: string;
  action: string;
  targetKind: string;
  targetId: string;
  reason: string;
  before: unknown;
  after: unknown;
}

export interface OpsLogFilters {
  actorUserId?: string;
  surface?: string;
  targetKind?: string;
  targetId?: string;
}

export interface OpsLogPage {
  rows: OpsLogRow[];
  total: number;
  page: number;
  pageSize: number;
}
