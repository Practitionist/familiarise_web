# Booking & Host Time

Applies to `lib/booking/`; the root `AGENTS.md` points `lib/appointments/` and `utils/scheduling-engine/` here too. The root `AGENTS.md` still applies.

1. **`occurrence_no_confirmed_overlap` has limits**: it guards only one host's live, non-tentative, non-cancelled occurrences. It does **not** cover tentative holds, co-host seats, a consultant booking as a client, or webinar/class attendee seats; those stay app-enforced (slot locks, the Serializable seat count) until the busy-time ledger lands. It also ignores CANCELLED and RESCHEDULED rows, while the app's occupancy checks still treat a RESCHEDULED row as holding its time.
2. **The allocator takes slot atoms like every other host-time writer**: one all-or-nothing `tryLockSlotBatch` (`utils/appointmentlock.ts`) over the host, ACCEPTED co-hosts and an expert buyer's own profile, after its search and before its write.
3. **Playbook**: `.claude/skills/booking/SKILL.md`.
