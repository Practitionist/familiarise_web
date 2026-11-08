import Link from "next/link";
import { Check } from "lucide-react";

import { Section } from "@/components/dashboard/Section";
import { Progress } from "@/components/ui/progress";
import type { ActivationStep } from "@/lib/enterprise/org-activation";

/** The "Get started" card shared by the organization and expert Homes. */
export function SetupChecklist({
  steps,
}: Readonly<{ steps: ActivationStep[] }>) {
  const done = steps.filter((s) => s.done).length;
  return (
    <Section
      title={`Get started — ${done} of ${steps.length} done`}
      variant="card"
    >
      <Progress value={(done / steps.length) * 100} className="mb-4 h-2" />
      <ul className="space-y-1">
        {steps.map((step) => (
          <li key={step.key}>
            <Link
              href={step.href}
              className="flex items-center gap-3 rounded-lg p-2 text-sm transition-colors hover:bg-muted"
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  step.done ? "border-green-600 bg-green-600" : "border-border"
                }`}
              >
                {step.done && <Check className="h-3 w-3 text-white" />}
              </span>
              <span
                className={
                  step.done ? "text-muted-foreground line-through" : ""
                }
              >
                {step.label}
                <span className="sr-only">
                  {step.done ? " (done)" : " (to do)"}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
