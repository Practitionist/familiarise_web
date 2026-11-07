/**
 * #1527 — the "Find" quick-jump index: every page the sidebar offers plus the
 * settings sections the viewer can open, built from the same nav builder
 * output and settings registries, so Find can never offer a page the sidebar
 * would hide. Pages only; no record search. Pure, so tests walk it.
 */

import { goLibraryHref } from "../go";
import type { DashboardNav } from "./types";

export interface FindEntry {
  label: string;
  href: string;
  /** The nav group caption, or the settings group, it is listed under. */
  group: string;
  /** Lower-cased label plus synonyms, matched word by word. */
  keywords: string;
}

/** A settings registry's grouped sections (SettingsLayout's shape). */
export interface FindSettingsGroup {
  title: string;
  sections: { label: string; href: string }[];
}

// Keyed by the last path segment; the words people type for that page.
const SYNONYMS: Record<string, string[]> = {
  home: ["overview", "dashboard", "start"],
  appointments: ["sessions", "bookings", "calendar", "schedule"],
  messages: ["chat", "inbox", "conversations"],
  billing: ["invoice", "invoices", "payment", "payments", "spend", "wallet"],
  payouts: ["earnings", "withdraw", "bank"],
  earnings: ["income", "payouts", "revenue", "money"],
  payments: ["invoice", "receipts", "charges"],
  members: ["people", "team", "users", "invite"],
  support: ["help", "ticket", "requests", "support requests", "cases"],
  requests: ["bookings", "pending", "approvals"],
  documents: ["files", "uploads", "materials"],
  recordings: ["recordings", "videos", "replays"],
  library: [
    "purchases",
    "products",
    "recordings",
    "documents",
    "downloads",
    "ebooks",
    "templates",
  ],
  sessions: ["offerings", "consultations", "subscriptions", "1:1"],
  programs: ["offerings", "webinars", "classes", "cohorts"],
  products: ["offerings", "digital products", "downloads", "ebooks", "files"],
  collaborations: ["co-host", "invitations", "collaborators"],
  analytics: ["reports", "metrics", "stats"],
  audit: ["log", "history"],
  consent: ["privacy", "dpdp", "data protection"],
  compensation: ["pay", "rates", "fees", "earnings"],
  reviews: ["ratings", "feedback", "testimonials"],
  referrals: ["referrals", "refer", "credits", "rewards"],
  settings: ["preferences", "account", "configure"],
  account: ["password", "security", "email"],
  profile: ["bio", "headline", "public page", "photo"],
  notifications: ["alerts", "email"],
  sso: ["sign-in", "saml", "login", "domains"],
  webhooks: ["integrations", "api"],
  "data-exports": ["export", "download", "dpdp"],
  "get-paid": ["bank", "payouts", "tax"],
  availability: ["schedule", "hours", "calendar"],
};

// A tree's own words replace the shared ones for that page: an organization
// sponsors programs rather than selling webinars, its Library holds only
// session documents and recordings, and a learner's credits live in Billing.
const TREE_SYNONYMS: Record<string, Record<string, string[]>> = {
  organization: {
    programs: ["sponsorship", "sponsor", "seats"],
    library: ["purchases", "recordings", "documents", "downloads"],
  },
  consultee: {
    payments: ["invoice", "receipts", "charges", "credits"],
  },
};

/** `/dashboard/<tree>/…` → the tree's segment ("organization", "consultant"). */
const treeOf = (basePath: string) => basePath.split("/")[2] ?? "";

const lastSegment = (path: string) =>
  path.split(/[/?#]/).findLast(Boolean) ?? path;

// A personal tree's own Library is the buyer Library that go/library opens.
const PERSONAL_BASE = /^\/dashboard\/(consultant|consultee)\//;

export function buildFindIndex({
  nav,
  settings = [],
  account = [],
}: {
  nav: Pick<DashboardNav, "basePath" | "groups">;
  settings?: FindSettingsGroup[];
  /** The avatar menu's settings links (personal, org, workspace). */
  account?: { label: string; href: string }[];
}): FindEntry[] {
  const entries: FindEntry[] = [];
  const seen = new Set<string>();
  const add = (label: string, href: string, group: string) => {
    if (seen.has(href)) return;
    seen.add(href);
    const segment = lastSegment(href);
    const synonyms =
      TREE_SYNONYMS[treeOf(nav.basePath)]?.[segment] ?? SYNONYMS[segment] ?? [];
    const words = [label, ...synonyms];
    entries.push({
      label,
      href,
      group,
      keywords: words.join(" ").toLowerCase(),
    });
  };
  for (const group of nav.groups) {
    for (const item of group.items) {
      add(item.name, `${nav.basePath}/${item.path}`, group.label ?? "Pages");
    }
  }
  if (
    PERSONAL_BASE.test(nav.basePath) &&
    nav.groups.some((g) => g.items.some((i) => i.path === "library"))
  ) {
    seen.add(goLibraryHref());
  }
  for (const link of account) add(link.label, link.href, "Account");
  for (const group of settings) {
    for (const section of group.sections) {
      add(section.label, section.href, `Settings · ${group.title}`);
    }
  }
  return entries;
}

/**
 * Rank of an entry for the query, lower first; null when a typed word matches
 * nothing. Exact label, then label prefix, then every word in the label, then
 * synonyms, then the group caption (#1527 QA G10: "invoice" must lead with
 * Invoices, not a page that lists it as a synonym).
 */
function rank(entry: FindEntry, query: string, words: string[]): number | null {
  const label = entry.label.toLowerCase();
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (words.every((w) => label.includes(w))) return 2;
  if (words.every((w) => entry.keywords.includes(w))) return 3;
  const group = entry.group.toLowerCase();
  if (words.every((w) => entry.keywords.includes(w) || group.includes(w))) {
    return 4;
  }
  return null;
}

/** Every typed word must match; best-ranked first, ties in index order. */
export function filterFind(entries: FindEntry[], query: string): FindEntry[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  const words = q.split(" ").filter(Boolean);
  if (words.length === 0) return entries;
  return entries
    .map((entry, i) => ({ entry, i, r: rank(entry, q, words) }))
    .filter(
      (x): x is { entry: FindEntry; i: number; r: number } => x.r !== null,
    )
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.entry);
}
