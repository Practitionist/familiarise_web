/** The expert's standing as the locked read in `lib/booking/expert-standing.ts` returns it. */
export interface StandingFacts {
  verificationStatus: string;
  deletedAt: Date | null;
}

export const VERIFIED_STANDING: StandingFacts = {
  verificationStatus: "VERIFIED",
  deletedAt: null,
};

/** A `$queryRaw` double answering the share-locked standing read with `facts`. */
export function standingRead(facts: StandingFacts = VERIFIED_STANDING) {
  return jest.fn(async () => [
    {
      verificationStatus: facts.verificationStatus,
      deletedAt: facts.deletedAt,
    },
  ]);
}
