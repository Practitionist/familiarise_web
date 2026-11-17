/** The fields an operator screen has for a person; any of them may be missing. */
export interface PersonLike {
  id?: string | null;
  name?: string | null;
  email?: string | null;
}

export interface PersonLabel {
  /** The name, else the email, else the anonymous label, else "Removed user". */
  primary: string;
  /** The email under a name; null when the email is already the primary line. */
  secondary: string | null;
  /** "Anonymous to the public" under a known name; null otherwise. */
  anonymous: string | null;
  /** The row id, shown muted so an operator can search for it. */
  id: string | null;
}

export const REMOVED_USER = "Removed user";

const clean = (value: string | null | undefined) => value?.trim() || null;

/** How every back-office screen names a person: name, then email, then a muted id. */
export function formatPerson(
  person: PersonLike | null | undefined,
  { anonymousLabel }: { anonymousLabel?: string } = {},
): PersonLabel {
  const name = clean(person?.name);
  const email = clean(person?.email);
  const known = name ?? email;
  return {
    primary: known ?? anonymousLabel ?? REMOVED_USER,
    secondary: name ? email : null,
    anonymous: known && anonymousLabel ? anonymousLabel : null,
    id: clean(person?.id),
  };
}
