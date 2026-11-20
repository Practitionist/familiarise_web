/**
 * The consultee Settings hub's sections (#1527 §14): one URL each under
 * `/settings/<slug>`, grouped the way the shared SettingsLayout shows them.
 * Directive-free so the server redirect page and the client layout share it.
 */

export type ConsulteeSettingsKey = "account" | "notifications" | "profile";

export interface ConsulteeSettingsSection {
  group: string;
  key: ConsulteeSettingsKey;
  label: string;
  slug: string;
  description: string;
}

export const CONSULTEE_SETTINGS_SECTIONS: readonly ConsulteeSettingsSection[] =
  [
    {
      group: "Account",
      key: "account",
      label: "Account",
      slug: "account",
      description:
        "Your details, password, sessions, connected accounts and data rights",
    },
    {
      group: "Account",
      key: "notifications",
      label: "Notifications",
      slug: "notifications",
      description: "Which updates reach you, and on which channel",
    },
    {
      group: "Learning",
      key: "profile",
      label: "Learning profile",
      slug: "profile",
      description: "Your goals, background and what you want to learn",
    },
  ];

export function consulteeSettingsHref(
  consulteeId: string,
  section: Pick<ConsulteeSettingsSection, "slug">,
): string {
  return `/dashboard/consultee/${consulteeId}/settings/${section.slug}`;
}

/** Sections only the owner sees: they read the signed-in viewer's own account. */
const SELF_ONLY: ReadonlySet<ConsulteeSettingsKey> = new Set([
  "account",
  "notifications",
]);

/** The sections in nav order, grouped under their titles; "Your …" copy and self-only sections for the owner only. */
export function consulteeSettingsGroups(
  consulteeId: string,
  viewerOwnsProfile = true,
) {
  const groups: {
    title: string;
    sections: {
      key: string;
      label: string;
      description?: string;
      href: string;
      show?: boolean;
    }[];
  }[] = [];
  for (const section of CONSULTEE_SETTINGS_SECTIONS) {
    const entry = {
      key: section.key,
      label: section.label,
      description: viewerOwnsProfile ? section.description : undefined,
      href: consulteeSettingsHref(consulteeId, section),
      show: viewerOwnsProfile || !SELF_ONLY.has(section.key),
    };
    const last = groups.at(-1);
    if (last?.title === section.group) last.sections.push(entry);
    else groups.push({ title: section.group, sections: [entry] });
  }
  return groups;
}
