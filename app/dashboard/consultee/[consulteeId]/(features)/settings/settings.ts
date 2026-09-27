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

/** `settings?view=sections` is the mobile list of sections, not a redirect. */
export const CONSULTEE_SETTINGS_LIST_VIEW = "sections";

export function consulteeSettingsHref(
  consulteeId: string,
  section: Pick<ConsulteeSettingsSection, "slug">,
): string {
  return `/dashboard/consultee/${consulteeId}/settings/${section.slug}`;
}

/** The sections in nav order, grouped under their titles. */
export function consulteeSettingsGroups(consulteeId: string) {
  const groups: {
    title: string;
    sections: {
      key: string;
      label: string;
      description: string;
      href: string;
    }[];
  }[] = [];
  for (const section of CONSULTEE_SETTINGS_SECTIONS) {
    const entry = {
      key: section.key,
      label: section.label,
      description: section.description,
      href: consulteeSettingsHref(consulteeId, section),
    };
    const last = groups.at(-1);
    if (last?.title === section.group) last.sections.push(entry);
    else groups.push({ title: section.group, sections: [entry] });
  }
  return groups;
}
