import { userRoleLabel } from "@/lib/labels/personal-dashboard";

/** The person whose personal dashboard the route opens, whoever is viewing it. */
export interface ViewedPerson {
  userId: string;
  name: string | null;
  image: string | null;
}

/** Both reads of `/api/user/consultees/[id]` (owner/admin include, staff select) carry these fields. */
export interface RouteProfileOwner {
  userId: string;
  user?: { name?: string | null; image?: string | null } | null;
}

export function viewedPerson(
  profile: RouteProfileOwner | null | undefined,
): ViewedPerson | null {
  if (!profile?.userId) return null;
  return {
    userId: profile.userId,
    name: profile.user?.name ?? null,
    image: profile.user?.image ?? null,
  };
}

/** The owner is welcomed back; an operator sees whose home this is. Null while loading. */
export function personalHomeTitle(
  person: ViewedPerson | null,
  viewerOwnsProfile: boolean,
): string | null {
  if (!person) return null;
  if (viewerOwnsProfile) {
    const first = person.name?.split(" ")[0];
    return first ? `Welcome back, ${first}` : "Welcome back";
  }
  return person.name ? `${person.name}'s home` : "This learner's home";
}

interface ShellPerson {
  name: string | null;
  image: string | null;
}

/**
 * The header avatar menu is always the signed-in viewer; the context bar names
 * the route profile's owner. In operator view the menu carries the operator's role.
 */
export function personalShellPeople({
  viewer,
  owner,
  operatorView,
  sideLabel,
}: Readonly<{
  viewer: ShellPerson & { role?: string | null };
  owner: ShellPerson;
  operatorView: boolean;
  sideLabel: string;
}>): {
  account: ShellPerson & { roleLabel: string };
  identity: ShellPerson;
} {
  if (operatorView) {
    return {
      account: {
        name: viewer.name,
        image: viewer.image,
        roleLabel: userRoleLabel(viewer.role),
      },
      identity: owner,
    };
  }
  const self = {
    name: owner.name ?? viewer.name,
    image: owner.image ?? viewer.image,
  };
  return { account: { ...self, roleLabel: sideLabel }, identity: self };
}

/**
 * The switcher in operator view: the operator's platform facet is current, and
 * the trigger says whose dashboard is open. The label is null until the owner's
 * name loads; null overall when the viewer has no platform facet.
 */
export function operatorSwitcherState(
  platformFacets: readonly { key: string; label: string }[],
  ownerName: string | null,
): { activeKey: string; label: string | null } | null {
  const facet = platformFacets[0];
  if (!facet) return null;
  return {
    activeKey: facet.key,
    label: ownerName ? `${facet.label} · viewing ${ownerName}` : null,
  };
}
