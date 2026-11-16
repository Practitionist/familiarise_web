import {
  formatOperatorInstant,
  formatUtcInstant,
  type Instant,
  type OperatorInstantKind,
} from "./operator-zone";

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
      title={formatUtcInstant(date)}
      className={className}
    >
      {formatOperatorInstant(date, kind)}
    </time>
  );
}
