/** The fields an operator screen has for a person; any of them may be missing. */
export interface PersonLike {
  id?: string | null;
  name?: string | null;
  email?: string | null;
}

export interface PersonLabel {
  /** The name, else the email, else "Removed user". */
  primary: string;
  /** The email under a name; null when the email is already the primary line. */
  secondary: string | null;
  /** The row id, shown muted so an operator can search for it. */
  id: string | null;
}

export const REMOVED_USER = "Removed user";

const clean = (value: string | null | undefined) => value?.trim() || null;

/** How every back-office screen names a person: name, then email, then a muted id. */
export function formatPerson(
  person: PersonLike | null | undefined,
): PersonLabel {
  const name = clean(person?.name);
  const email = clean(person?.email);
  return {
    primary: name ?? email ?? REMOVED_USER,
    secondary: name ? email : null,
    id: clean(person?.id),
  };
}
