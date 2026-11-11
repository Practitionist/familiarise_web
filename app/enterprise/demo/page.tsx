import type { Metadata } from "next";
import { CalendarCheck, FileText, Users } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { z } from "zod";
import { DemoForm } from "./DemoForm";
import { DEMO_USE_CASE_VALUES, type DemoUseCase } from "./constants";

export const metadata: Metadata = {
  title: "Book a demo | Familiarise for business",
  description:
    "See how organisations fund expert sessions for their people: seats, credit pools, wallet or monthly invoice, with GST-compliant billing.",
};

const WHAT_HAPPENS_NEXT = [
  {
    icon: FileText,
    title: "We read your request",
    body: "Your answers go straight to the team that scopes funding, not to a general inbox.",
  },
  {
    icon: CalendarCheck,
    title: "We propose a walkthrough",
    body: "A short call covering funding options, assignments and billing for your size.",
  },
  {
    icon: Users,
    title: "We set up a pilot",
    body: "Sales-assisted onboarding: verified domain, billing account and your first cohort.",
  },
];

const UseCaseParam = z.enum(DEMO_USE_CASE_VALUES);

function parseUseCase(value: unknown): DemoUseCase | "" {
  return UseCaseParam.safeParse(value).data ?? "";
}

export default async function EnterpriseDemoPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const initialUseCase = parseUseCase((await searchParams).useCase);

  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center mb-10">
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            Book a demo
          </h1>
          <p className="text-fluid-lg text-muted-foreground max-w-3xl mx-auto">
            Tell us about your organisation and we will show you how expert
            sessions are funded, assigned and billed for teams.
          </p>
        </div>

        <div className="max-w-6xl mx-auto grid lg:grid-cols-5 gap-8">
          <ol className="lg:col-span-2 space-y-6">
            {WHAT_HAPPENS_NEXT.map(({ icon: Icon, title, body }, index) => (
              <li key={title} className="flex items-start gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                  <Icon className="h-5 w-5" aria-hidden />
                </div>
                <div>
                  <h2 className="font-semibold mb-1">
                    {index + 1}. {title}
                  </h2>
                  <p className="text-sm text-muted-foreground">{body}</p>
                </div>
              </li>
            ))}
          </ol>

          <Card className="lg:col-span-3 shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">Your details</CardTitle>
              <CardDescription>
                Work email please, so we can confirm your organisation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DemoForm initialUseCase={initialUseCase} />
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
