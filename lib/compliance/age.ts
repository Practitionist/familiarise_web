/**
 * Age of majority gate — DPDP Act 2023 (#1132).
 *
 * India's "child" is anyone under EIGHTEEN (s.2(f)), not the COPPA 13 the
 * privacy policy used to quote. Processing a child's personal data requires
 * verifiable parental consent (s.9(1), Rule 10), and s.9(3) bans behavioural
 * tracking and targeted advertising to children outright. We sell classes and
 * mentoring, so students are squarely in the target market — there is no
 * "we don't serve minors" story that survives contact with the product.
 *
 * Collecting a date of birth to run this check is itself exempt: Fourth
 * Schedule Part B item 6 covers "confirmation by the Data Fiduciary that the
 * Data Principal is not a child, and observance of due diligence under rule
 * 10". So the gate creates no new obligation — it discharges one.
 *
 * Rules 3 and 5-16 commence 13 May 2027 (G.S.R. 846(E)), so this is a deadline
 * rather than a live breach today. It is cheap now and expensive to retrofit
 * once accounts exist, which is why it ships ahead of the deadline.
 */

/** DPDP s.2(f) — a "child" is an individual who has not completed 18 years. */
export const AGE_OF_MAJORITY = 18;

/**
 * True when a `YYYY-MM-DD` string names a date that actually exists.
 *
 * #1132 — `new Date("2001-02-29")` does not throw; it rolls forward to
 * 2001-03-01. Anything that coerces before validating is therefore checking a
 * birthday the user never entered. Non-ISO strings pass through here and are
 * left to `Date` parsing to reject.
 */
export function isRealCalendarDate(value: string): boolean {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!iso) return !Number.isNaN(new Date(value).getTime());
  const [, y, m, d] = iso;
  const probe = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
  return (
    !Number.isNaN(probe.getTime()) &&
    probe.getUTCFullYear() === Number(y) &&
    probe.getUTCMonth() + 1 === Number(m) &&
    probe.getUTCDate() === Number(d)
  );
}

/**
 * Whole years elapsed between `dob` and `asOf`, calendar-correct (an 18th
 * birthday today counts as 18). Returns null for an absent or unparseable date.
 */
export function ageInYears(
  dob: Date | string | null | undefined,
  asOf: Date = new Date(),
): number | null {
  if (!dob) return null;

  // A calendar date that does not exist is bad input, not a date one day
  // later — see isRealCalendarDate.
  if (typeof dob === "string" && !isRealCalendarDate(dob)) return null;

  const d = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(d.getTime())) return null;

  let age = asOf.getUTCFullYear() - d.getUTCFullYear();
  const monthDelta = asOf.getUTCMonth() - d.getUTCMonth();
  if (
    monthDelta < 0 ||
    (monthDelta === 0 && asOf.getUTCDate() < d.getUTCDate())
  ) {
    age -= 1;
  }
  return age;
}

/**
 * True only when the date of birth is present, sane, and puts the person at or
 * past the age of majority. Fails closed: a missing or future date is NOT an
 * adult, because an unknown age must never be treated as consentable.
 */
export function isAdult(
  dob: Date | string | null | undefined,
  asOf: Date = new Date(),
): boolean {
  const age = ageInYears(dob, asOf);
  if (age === null) return false;
  // A negative age means the date is in the future — junk input, not an adult.
  if (age < 0) return false;
  // Beyond any plausible human lifespan; treat as a typo rather than accepting.
  if (age > 120) return false;
  return age >= AGE_OF_MAJORITY;
}

/** Copy shown when the gate rejects. Kept here so UI and API cannot drift. */
export const UNDER_AGE_MESSAGE = `You must be at least ${AGE_OF_MAJORITY} years old to use Familiarise.`;
