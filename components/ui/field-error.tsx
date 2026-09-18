import { cn } from "@/utils/tailwind";

interface FieldErrorProps {
  /** Pair with the input's `aria-describedby` so screen readers read it. */
  id?: string;
  message?: string | null;
  className?: string;
}

/**
 * The one way an inline field error is rendered. `data-field-error` is what
 * `scrollToFirstError` looks for, so a step that uses this component gets
 * "jump to the first problem" for free.
 */
export function FieldError({
  id,
  message,
  className,
}: Readonly<FieldErrorProps>) {
  if (!message) return null;
  return (
    <p
      id={id}
      role="alert"
      data-field-error=""
      className={cn("text-sm text-destructive", className)}
    >
      {message}
    </p>
  );
}
