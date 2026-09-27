/**
 * #1527 — the "Find" quick-jump index: every page the sidebar offers plus the
 * settings sections the viewer can open, built from the same nav builder
 * output and settings registries, so Find can never offer a page the sidebar
 * would hide. Pages only; no record search. Pure, so tests walk it.
 */

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
  earnings: ["income", "payouts", "revenue"],
  payments: ["invoice", "receipts", "charges"],
  members: ["people", "team", "users", "invite"],
  support: ["help", "ticket", "requests"],
  documents: ["files", "uploads", "materials"],
  recordings: ["videos", "replays"],
  analytics: ["reports", "metrics", "stats"],
  audit: ["log", "history"],
  settings: ["preferences", "account", "configure"],
  notifications: ["alerts", "email"],
  sso: ["sign-in", "saml", "login", "domains"],
  scim: ["directory", "provisioning"],
  webhooks: ["integrations", "api"],
  "data-exports": ["export", "download", "dpdp"],
  "get-paid": ["bank", "payouts", "tax"],
  availability: ["schedule", "hours", "calendar"],
};

const lastSegment = (path: string) =>
  path.split(/[/?#]/).filter(Boolean).at(-1) ?? path;

export function buildFindIndex({
  nav,
  settings = [],
  account = [],
}: {
  nav: Pick<DashboardNav, "basePath" | "groups" | "settings">;
  settings?: FindSettingsGroup[];
  /** The avatar menu's settings links (personal, org, workspace). */
  account?: { label: string; href: string }[];
}): FindEntry[] {
  const entries: FindEntry[] = [];
  const seen = new Set<string>();
  const add = (label: string, href: string, group: string) => {
    if (seen.has(href)) return;
    seen.add(href);
    const words = [label, ...(SYNONYMS[lastSegment(href)] ?? [])];
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
  if (nav.settings) {
    add(nav.settings.name, `${nav.basePath}/${nav.settings.path}`, "Account");
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
