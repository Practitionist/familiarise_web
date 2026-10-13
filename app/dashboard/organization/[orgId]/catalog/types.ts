/** Shared shapes for the org catalog surface. */

export type Kind = "WEBINAR" | "CLASS";

/** Row as the API returns it — `price` is a paise string (BigInt on the wire). */
export interface CatalogRow {
  id: string;
  title: string;
  price: string;
  visibility: "PUBLIC" | "ORG_ONLY" | "ORG_AND_PUBLIC";
  maxParticipants: number;
  consultantProfileId: string | null;
  consultantName?: string | null;
  consultantProfile?: {
    id: string;
    userId?: string;
    user?: { name?: string | null; email?: string | null } | null;
  } | null;
  topics?: Array<{ id?: string; name?: string } | string>;
  topicsCount?: number;
  _count?: { topics?: number };
  isDraft?: boolean;
  status?: string | null;
  webinars?: Array<{ status?: string | null }>;
  classes?: Array<{ status?: string | null }>;
  archivedAt: string | null;
}

export interface CatalogResponse {
  webinars: CatalogRow[];
  classes: CatalogRow[];
}
