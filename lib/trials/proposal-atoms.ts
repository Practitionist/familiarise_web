const ATOM_MS = 30 * 60_000;

/**
 * A trial's new window as the 30-minute rows the reschedule route takes
 * (`RescheduleProposalSchema` reads one row as one atom).
 */
export function trialProposalAtoms(
  startsAt: Date,
  endsAt: Date,
): { startsAt: string; endsAt: string }[] {
  const atoms: { startsAt: string; endsAt: string }[] = [];
  for (let t = startsAt.getTime(); t < endsAt.getTime(); t += ATOM_MS) {
    atoms.push({
      startsAt: new Date(t).toISOString(),
      endsAt: new Date(t + ATOM_MS).toISOString(),
    });
  }
  return atoms;
}
