export function startOfWeekSunday(d: Date): Date {
  const date = new Date(d);
  // Normalize to midnight to avoid DST/timezone artifacts in comparisons
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0 = Sunday
  const diff = day; // days since Sunday
  const start = new Date(date);
  start.setDate(date.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

export function endOfWeekSaturday(d: Date): Date {
  const start = startOfWeekSunday(d);
  const end = new Date(start);
  end.setDate(start.getDate() + 6); // Saturday
  end.setHours(23, 59, 59, 999);
  return end;
}

export function getWeeklyCallCount(
  startDate: Date | string,
  endDate: Date | string
): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error("Invalid date provided to getWeeklyCallCount");
  }
  if (end < start) return 0;

  const firstWeekStart = startOfWeekSunday(start);
  const lastWeekStart = startOfWeekSunday(end);

  // Number of weeks = difference in week starts / 7 days + 1 (inclusive)
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor(
    (lastWeekStart.getTime() - firstWeekStart.getTime()) / msPerDay
  );
  const weeks = Math.floor(diffDays / 7) + 1;
  return weeks;
}

export function getWeekBoundaries(
  startDate: Date | string,
  endDate: Date | string
): Array<{ weekStart: Date; weekEnd: Date }> {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error("Invalid date provided to getWeekBoundaries");
  }
  if (end < start) return [];

  const weeks: Array<{ weekStart: Date; weekEnd: Date }> = [];
  let cursor = startOfWeekSunday(start);
  const lastWeekStart = startOfWeekSunday(end);

  while (cursor.getTime() <= lastWeekStart.getTime()) {
    const weekStart = new Date(cursor);
    const weekEnd = endOfWeekSaturday(cursor);
    weeks.push({ weekStart, weekEnd });
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + 7);
  }

  return weeks;
}
