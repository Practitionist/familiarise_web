import { Button } from "@/components/ui/button";
import { Clock } from "lucide-react";

interface UnscheduledEventCardProps {
  title: string;
  subtitle: string;
  onSetSchedule: () => void;
}

export function UnscheduledEventCard({
  title,
  subtitle,
  onSetSchedule,
}: UnscheduledEventCardProps) {
  return (
    <div className="border rounded-lg p-4 bg-gray-50 flex items-center justify-between">
      <div>
        <p className="font-medium text-gray-900">{title}</p>
        <p className="text-xs text-gray-500 mt-1">{subtitle}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs px-3"
        onClick={onSetSchedule}
      >
        <Clock className="w-3 h-3 mr-1" />
        Set Schedule
      </Button>
    </div>
  );
}
