"use client";

import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";

export interface CaseShortcut {
  keys: string[];
  description: string;
}

/**
 * The queue's keyboard shortcuts. They are FOCUS-SCOPED (WCAG 2.1.4): they
 * only fire while the focus is inside the queue and the operator is not
 * typing in a field, so a character key never steals a keystroke and an
 * operator can always leave them by moving the focus out.
 */
export const CASE_SHORTCUTS: CaseShortcut[] = [
  { keys: ["/"], description: "Focus the search box" },
  { keys: ["j"], description: "Open the next case in the queue" },
  { keys: ["k"], description: "Open the previous case in the queue" },
  { keys: ["a"], description: "Assign the selected cases to me" },
  { keys: ["?"], description: "Show this help" },
];

/** The help sheet; it is also reachable from the queue's toolbar button. */
export function CaseShortcutHelp({
  open,
  onOpenChange,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-md">
        <ResponsiveModalTitle>Keyboard shortcuts</ResponsiveModalTitle>
        <ResponsiveModalDescription className="sr-only">
          The shortcuts that work while the support queue has focus.
        </ResponsiveModalDescription>
        <dl className="space-y-2">
          {CASE_SHORTCUTS.map((s) => (
            <div
              key={s.keys.join("+")}
              className="flex items-center justify-between gap-4"
            >
              <dt className="flex items-center gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="rounded border border-border bg-muted px-1.5 font-mono text-[11px] text-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </dt>
              <dd className="text-sm text-muted-foreground">{s.description}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          These shortcuts are active only while the queue has focus, and never
          while you are typing in a field.
        </p>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
