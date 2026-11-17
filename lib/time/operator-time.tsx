import {
  formatOperatorInstant,
  formatUtcInstant,
  type Instant,
  type OperatorInstantKind,
} from "./operator-zone";

/** An instant on two lines, date over time, so a narrow column never wraps it word by word. */
export function OperatorTimeStack({
  value,
  fallback = "—",
}: Readonly<{ value: Instant | null | undefined; fallback?: string }>) {
  if (value === null || value === undefined) return <>{fallback}</>;
  return (
    <span className="flex flex-col whitespace-nowrap">
      <OperatorTime value={value} kind="date" />
      <OperatorTime
        value={value}
        kind="time"
        className="text-xs text-muted-foreground"
      />
    </span>
  );
}

/** An instant in India time, with its UTC reading one hover away. */
export function OperatorTime({
  value,
  kind = "dateTime",
  fallback = "—",
  className,
}: Readonly<{
  value: Instant | null | undefined;
  kind?: OperatorInstantKind;
  fallback?: string;
  className?: string;
}>) {
  const date = value === null || value === undefined ? null : new Date(value);
  if (!date || Number.isNaN(date.getTime())) return <>{fallback}</>;
  return (
    <time
      dateTime={date.toISOString()}
      // A bare date is the IST day; the hover says so beside the UTC reading.
      title={
        kind === "date"
          ? `IST day · ${formatUtcInstant(date)}`
          : formatUtcInstant(date)
      }
      className={className}
    >
      {formatOperatorInstant(date, kind)}
    </time>
  );
}
