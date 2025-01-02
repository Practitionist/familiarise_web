export function formatTimeString(d: Date): string {
  let hours = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours >= 12 ? "pm" : "am";

  if (hours === 0) hours = 12;
  else if (hours > 12) hours -= 12;

  return `${hours}:${minutes.toString().padStart(2, "0")} ${ampm}`;
}

export function formatDateTime(date: Date, endTime?: Date): string {
  const dateStr = date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const timeStr = endTime
    ? `${formatTimeString(date)} - ${formatTimeString(endTime)}`
    : formatTimeString(date);

  return `${dateStr}, ${timeStr}`;
}
