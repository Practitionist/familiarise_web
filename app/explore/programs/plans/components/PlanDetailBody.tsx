import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CurriculumOutline,
  PlanFaqAccordion,
  TargetAudience,
  WhatsIncluded,
  type CurriculumItem,
  type PlanFaqItem,
} from "@/components/plans/PlanContentSections";

/**
 * The content column shared by all four plan detail pages.
 *
 * Class and webinar detail were already near-duplicates of each other; adding
 * subscription and consultation as two more copies would have quadrupled the
 * drift surface and pushed the duplication gate further out. Each page keeps
 * its own hero, facts grid and booking sidebar — the parts that genuinely
 * differ per type — and composes this for everything in between.
 *
 * Every section returns null when empty, so a sparsely-authored plan renders a
 * short page rather than a run of empty bordered cards with headings.
 */
export interface PlanDetailBodyProps {
  aboutHeading: string;
  description?: string | null;
  learningOutcomes?: string[];
  targetAudience?: string[];
  whatsIncluded?: string[];
  curriculum?: CurriculumItem[] | null;
  curriculumHeading?: string;
  prerequisites?: string | null;
  materialProvided?: string | null;
  faqs?: PlanFaqItem[] | null;
  topics?: { id: string; name: string }[];
}

function SectionCard({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <Card className="rounded-2xl border-border shadow-sm">
      <CardContent className="p-6 md:p-8 lg:p-10">{children}</CardContent>
    </Card>
  );
}

export function PlanDetailBody({
  aboutHeading,
  description,
  learningOutcomes,
  targetAudience,
  whatsIncluded,
  curriculum,
  curriculumHeading = "What we'll cover",
  prerequisites,
  materialProvided,
  faqs,
  topics,
}: Readonly<PlanDetailBodyProps>) {
  // "None" is the historical default on prerequisites/materialProvided, so it
  // means "nothing to say" rather than a value worth giving a card to.
  const hasPrerequisites = prerequisites && prerequisites !== "None";
  const hasMaterials = materialProvided && materialProvided !== "None";
  const hasPositioning =
    (targetAudience?.length ?? 0) > 0 || (whatsIncluded?.length ?? 0) > 0;

  return (
    <>
      {description && (
        <SectionCard>
          <h2 className="mb-4 text-fluid-xl font-semibold tracking-tight text-foreground">
            {aboutHeading}
          </h2>
          <p className="max-w-prose whitespace-pre-line leading-7 text-muted-foreground">
            {description}
          </p>
        </SectionCard>
      )}

      {hasPositioning && (
        <SectionCard>
          <div className="space-y-6">
            <TargetAudience items={targetAudience} />
            <WhatsIncluded items={whatsIncluded} />
          </div>
        </SectionCard>
      )}

      {(learningOutcomes?.length ?? 0) > 0 && (
        <SectionCard>
          <h2 className="mb-4 text-fluid-xl font-semibold tracking-tight text-foreground">
            What you&apos;ll learn
          </h2>
          <ul className="grid md:grid-cols-2 gap-3">
            {learningOutcomes!.map((outcome) => (
              <li
                key={outcome}
                className="flex items-start gap-3 text-muted-foreground"
              >
                <span className="mt-2 w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                {outcome}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {(curriculum?.length ?? 0) > 0 && (
        <SectionCard>
          <CurriculumOutline items={curriculum} title={curriculumHeading} />
        </SectionCard>
      )}

      {hasPrerequisites && (
        <SectionCard>
          <h2 className="mb-4 text-fluid-xl font-semibold tracking-tight text-foreground">
            Prerequisites
          </h2>
          <p className="text-muted-foreground whitespace-pre-line">
            {prerequisites}
          </p>
        </SectionCard>
      )}

      {hasMaterials && (
        <SectionCard>
          <h2 className="mb-4 text-fluid-xl font-semibold tracking-tight text-foreground">
            Materials provided
          </h2>
          <p className="text-muted-foreground whitespace-pre-line">
            {materialProvided}
          </p>
        </SectionCard>
      )}

      {(faqs?.length ?? 0) > 0 && (
        <SectionCard>
          <PlanFaqAccordion faqs={faqs} />
        </SectionCard>
      )}

      {(topics?.length ?? 0) > 0 && (
        <SectionCard>
          <h2 className="mb-4 text-fluid-xl font-semibold tracking-tight text-foreground">
            Topics covered
          </h2>
          <div className="flex flex-wrap gap-2">
            {topics!.map((topic) => (
              <Badge
                key={topic.id}
                className="bg-muted text-muted-foreground hover:bg-muted/70 px-3 py-1"
              >
                {topic.name}
              </Badge>
            ))}
          </div>
        </SectionCard>
      )}
    </>
  );
}
