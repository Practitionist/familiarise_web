import { programFacts } from "@/lib/explore/program-facts";
import type { Program } from "@/lib/explore/programs";

const NOW = new Date("2026-11-09T06:00:00Z");

const webinar = (extra: Record<string, unknown> = {}) =>
  ({
    type: "webinar",
    durationInHours: 1.5,
    level: "ALL_LEVELS",
    language: "English",
    recordingEnabled: false,
    certificateProvided: false,
    ...extra,
  }) as unknown as Program;

const klass = (extra: Record<string, unknown> = {}) =>
  ({
    type: "class",
    totalSessions: 12,
    durationInMonths: 3,
    level: "BEGINNER",
    language: "Hindi",
    recordingEnabled: true,
    certificateProvided: true,
    classes: [],
    ...extra,
  }) as unknown as Program;

describe("programFacts", () => {
  it("describes a webinar by length, level and language", () => {
    expect(programFacts(webinar(), NOW)).toEqual({
      facts: ["1.5h", "All levels", "English"],
      includes: [],
    });
  });

  it("describes a class by sessions and months, and lists what it includes", () => {
    expect(programFacts(klass(), NOW)).toEqual({
      facts: ["12 sessions over 3 months", "Beginner", "Hindi"],
      includes: ["Recording included", "Certificate"],
    });
  });

  it("names the next batch start and ignores past batches", () => {
    const { facts } = programFacts(
      klass({
        classes: [
          { id: "a", schedulingPeriodStartsAt: "2026-10-01T00:00:00Z" },
          { id: "b", schedulingPeriodStartsAt: "2026-12-01T04:00:00Z" },
          { id: "c", schedulingPeriodStartsAt: "2027-01-05T04:00:00Z" },
        ],
      }),
      NOW,
    );
    expect(facts.at(-1)).toBe("Starts 1 Dec");
  });

  it("uses singular nouns for one session in one month", () => {
    expect(
      programFacts(klass({ totalSessions: 1, durationInMonths: 1 }), NOW)
        .facts[0],
    ).toBe("1 session over 1 month");
  });
});
