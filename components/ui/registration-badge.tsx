import { CheckCircle } from "lucide-react";
import { Badge } from "./badge";

interface RegistrationBadgeProps {
  type: "webinar" | "class";
  /** Compact mode for card overlays - shows only icon and short text */
  compact?: boolean;
}

/**
 * Displays a registration/enrollment status badge.
 * Use this on cards and list items where users have already registered.
 */
export function RegistrationBadge({
  type,
  compact = false,
}: Readonly<RegistrationBadgeProps>) {
  const text = type === "webinar" ? "Registered" : "Enrolled";
  const fullText =
    type === "webinar" ? "Already Registered" : "Already Enrolled";

  if (compact) {
    return (
      <Badge className="bg-green-100 text-green-800 border-green-300 text-xs gap-1 px-2 py-0.5">
        <CheckCircle className="h-3 w-3" />
        {text}
      </Badge>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <CheckCircle className="h-5 w-5 text-green-600" />
      <Badge className="bg-green-100 text-green-800 border-green-300">
        {fullText}
      </Badge>
    </div>
  );
}
