"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The Reset / Save pair under every section that rides the combined settings PUT. */
export function SettingsFormActions({
  isSaving,
  onReset,
}: {
  isSaving: boolean;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end sm:space-x-4">
      <Button
        type="button"
        variant="outline"
        className="w-full sm:w-auto"
        onClick={onReset}
        disabled={isSaving}
      >
        Reset
      </Button>
      <Button
        type="submit"
        className="w-full bg-primary hover:bg-primary/90 text-primary-foreground sm:w-auto sm:min-w-[200px]"
        disabled={isSaving}
      >
        {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
        Save Changes
      </Button>
    </div>
  );
}
