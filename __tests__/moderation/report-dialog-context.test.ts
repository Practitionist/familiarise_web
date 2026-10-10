/**
 * @jest-environment node
 */

/**
 * The moderation report dialog names the reason in plain words and warns when
 * excluding the reported review would unpublish the expert's score.
 */

import { reportReasonLabel } from "@/lib/labels/report-reasons";
import {
  MIN_RATED_CLIENTS_ONE_TO_ONE,
  exclusionUnpublishesScore,
} from "@/lib/reviews";

const oneToOne = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    rating: 4,
    track: "ONE_TO_ONE" as const,
    ratingUnitId: null,
  }));

describe("reportReasonLabel", () => {
  it("labels known codes, humanises other codes and leaves prose alone", () => {
    expect(reportReasonLabel("HARASSMENT_OR_ABUSE")).toBe(
      "Harassment or abusive language",
    );
    expect(reportReasonLabel("HARASSMENT")).toBe("Harassment");
    expect(reportReasonLabel("Reported message")).toBe("Reported message");
  });
});

describe("exclusionUnpublishesScore", () => {
  it("is true only when the review holds the track exactly at the gate", () => {
    expect(
      exclusionUnpublishesScore(oneToOne(MIN_RATED_CLIENTS_ONE_TO_ONE), "r0"),
    ).toBe(true);
    expect(
      exclusionUnpublishesScore(
        oneToOne(MIN_RATED_CLIENTS_ONE_TO_ONE + 1),
        "r0",
      ),
    ).toBe(false);
    expect(
      exclusionUnpublishesScore(
        oneToOne(MIN_RATED_CLIENTS_ONE_TO_ONE),
        "not-counted",
      ),
    ).toBe(false);
  });
});
