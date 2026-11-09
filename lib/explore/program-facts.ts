import { isClassProgram, type Program } from "@/lib/explore/programs";

const LEVEL_LABEL: Record<string, string> = {
  BEGINNER: "Beginner",
  INTERMEDIATE: "Intermediate",
  ADVANCED: "Advanced",
  ALL_LEVELS: "All levels",
};

export interface ProgramFacts {
  /** Short plain facts for one line under the description: size, level, language, start. */
  facts: string[];
  /** Only what the plan really includes. */
  includes: string[];
}

function hours(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}h`;
}

/** The earliest class batch start still ahead of `now`, or null. */
function nextClassStart(
  program: Extract<Program, { type: "class" }>,
  now: Date,
): Date | null {
  const starts = (program.classes ?? [])
    .map((batch) =>
      batch.schedulingPeriodStartsAt
        ? new Date(batch.schedulingPeriodStartsAt)
        : null,
    )
    .filter((d): d is Date => d !== null && d.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  return starts[0] ?? null;
}

export function programFacts(program: Program, now: Date): ProgramFacts {
  const facts: string[] = [];

  if (isClassProgram(program)) {
    facts.push(
      `${program.totalSessions} ${program.totalSessions === 1 ? "session" : "sessions"} over ${program.durationInMonths} ${program.durationInMonths === 1 ? "month" : "months"}`,
    );
  } else {
    facts.push(hours(program.durationInHours));
  }
  const level = LEVEL_LABEL[program.level];
  if (level) facts.push(level);
  if (program.language) facts.push(program.language);
  if (isClassProgram(program)) {
    const start = nextClassStart(program, now);
    if (start) {
      facts.push(
        `Starts ${start.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}`,
      );
    }
  }

  const includes: string[] = [];
  if (program.recordingEnabled) includes.push("Recording included");
  if (program.certificateProvided) includes.push("Certificate");

  return { facts, includes };
}
