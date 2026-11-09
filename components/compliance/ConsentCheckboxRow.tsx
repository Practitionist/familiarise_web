import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/utils/tailwind";

/** One consent checkbox with its label; `optional` draws the dashed, unbundled row. */
export function ConsentCheckboxRow({
  id,
  checked,
  onCheckedChange,
  optional = false,
  children,
}: Readonly<{
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  optional?: boolean;
  children: ReactNode;
}>) {
  return (
    <div
      className={cn(
        "flex items-start space-x-3 rounded-lg border p-4 transition-colors",
        optional
          ? "border-dashed border-border bg-muted/30 hover:bg-muted/50"
          : "bg-muted/50 hover:bg-muted",
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="mt-0.5 h-5 w-5"
      />
      <Label
        htmlFor={id}
        className="cursor-pointer text-sm font-normal leading-snug"
      >
        {children}
      </Label>
    </div>
  );
}
