import prisma from "../../lib/prisma";
import { recomputeMenteesHelped } from "../../lib/profiles/mentees-helped";

/**
 * One pass over every consultant, writing the derived
 * `ConsultantProfile.totalMenteesHelped`.
 *
 * The column used to be seeded with a random integer, so this is the first
 * thing that ever made it mean anything: a seeded consultant's public stat is
 * now the number of distinct people the seeded bookings actually delivered a
 * session to, which is a small number for a dev database and exactly right —
 * a big number here would be the faker value the change removed.
 *
 * Runs here rather than in 1a because it needs the bookings, which Phase 6
 * creates. It is per-consultant and best-effort: one consultant's failure must
 * not abort a seed that has already built eight phases of data.
 */
export async function recomputeAllMenteesHelped(): Promise<void> {
  const consultants = await prisma.consultantProfile.findMany({
    select: { id: true },
  });
  let written = 0;
  let failed = 0;
  for (const consultant of consultants) {
    try {
      const total = await recomputeMenteesHelped(prisma, consultant.id);
      if (total !== null) written += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `  ⚠️ Mentees-helped recompute failed for ${consultant.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  console.log(
    `  Mentees helped: derived for ${written} consultant(s)${
      failed ? `, ${failed} failed` : ""
    }`,
  );
}
