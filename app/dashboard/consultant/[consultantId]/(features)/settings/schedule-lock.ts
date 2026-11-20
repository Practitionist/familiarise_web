import { z } from "zod";

/** The switch route's answer: `details` is its comma-joined counts ("2 upcoming classes, 1 active trial"). */
const scheduleSwitchSchema = z.object({
  canSwitch: z.boolean(),
  details: z.string().optional(),
});

export const SCHEDULE_LOCK_FALLBACK =
  "You have active bookings. Complete or cancel them before you switch schedule types.";

const LIST = new Intl.ListFormat("en-GB", {
  style: "long",
  type: "conjunction",
});

/** Why the Weekly/Custom switch is locked, in sentences; null when it is open or the answer is unreadable. */
export function scheduleLockReason(body: unknown): string | null {
  const parsed = scheduleSwitchSchema.safeParse(body);
  if (!parsed.success || parsed.data.canSwitch) return null;
  const counts = parsed.data.details?.split(", ").filter(Boolean) ?? [];
  if (counts.length === 0) return SCHEDULE_LOCK_FALLBACK;
  return `You have ${LIST.format(counts)}. Complete or cancel them before you switch schedule types.`;
}
