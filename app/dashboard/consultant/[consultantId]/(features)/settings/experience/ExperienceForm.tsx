"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ErrorState } from "@/components/dashboard/ErrorState";
import { SettingsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { Section } from "@/components/dashboard/Section";
import { SettingsSaveBar } from "@/components/dashboard/SettingsLayout";
import { useToast } from "@/hooks/use-toast";
import { requireJsonResponse } from "@/lib/fetch-helpers";
import {
  WorkExperienceSection,
  type WorkExperience,
} from "@/app/form/onboarding/components/experience/WorkExperienceSection";
import {
  EducationSection,
  type Education,
} from "@/app/form/onboarding/components/experience/EducationSection";
import {
  CertificationsSection,
  type Certification,
} from "@/app/form/onboarding/components/experience/CertificationsSection";
import AchievementsSection, {
  type Achievement,
} from "@/app/form/onboarding/components/experience/AchievementsSection";

interface Background {
  workExperiences: WorkExperience[];
  educationHistory: Education[];
  certificationsList: Certification[];
  achievements: Achievement[];
}

const EXPERIENCE_URL = "/api/consultant/experience";
const experienceKey = ["consultant-experience"] as const;

const toDate = (value: unknown) => (value ? new Date(value as string) : null);

/** JSON carries dates as strings; the onboarding cards format Date objects. */
function revive(data: Background): Background {
  return {
    ...data,
    workExperiences: data.workExperiences.map((w) => ({
      ...w,
      startDate: toDate(w.startDate) ?? new Date(),
      endDate: toDate(w.endDate),
    })),
    certificationsList: data.certificationsList.map((c) => ({
      ...c,
      issueDate: toDate(c.issueDate) ?? new Date(),
      expiryDate: toDate(c.expiryDate),
    })),
  };
}

async function readBackground(response: Response, fallback: string) {
  const body = (await requireJsonResponse(response, fallback)) as {
    data: Background;
  };
  return revive(body.data);
}

/**
 * The four onboarding lists, editable after onboarding (#1527 §14). The cards
 * are the onboarding step's own, so adding a role here looks and validates
 * exactly as it did the first time; one save replaces all four.
 */
export function ExperienceForm() {
  const query = useQuery({
    queryKey: experienceKey,
    queryFn: async () =>
      readBackground(
        await fetch(EXPERIENCE_URL, { cache: "no-store" }),
        "Couldn't load your experience",
      ),
    refetchOnWindowFocus: false,
  });

  if (query.isLoading) return <SettingsSkeleton />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title="Couldn't load your experience"
        onRetry={() => void query.refetch()}
      />
    );
  }
  // Keyed by the load, so a save or refetch resets the editor to the server.
  return <ExperienceEditor key={query.dataUpdatedAt} initial={query.data} />;
}

function ExperienceEditor({ initial }: Readonly<{ initial: Background }>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Background>(initial);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set =
    <K extends keyof Background>(key: K) =>
    (value: Background[K]) =>
      setDraft((prev) => ({ ...prev, [key]: value }));

  const save = useMutation({
    mutationFn: async (body: Background) =>
      readBackground(
        await fetch(EXPERIENCE_URL, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        "Couldn't save your experience",
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(experienceKey, saved);
      toast({
        title: "Experience saved",
        description: "Your public profile shows the changes.",
      });
    },
    onError: (error: Error) =>
      toast({
        title: "Couldn't save your experience",
        description: error.message,
        variant: "destructive",
      }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(draft);
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-6"
      aria-label="Experience and education"
    >
      <Section title="Work experience" variant="card">
        <WorkExperienceSection
          experiences={draft.workExperiences}
          onUpdate={set("workExperiences")}
        />
      </Section>
      <Section title="Education" variant="card">
        <EducationSection
          education={draft.educationHistory}
          onUpdate={set("educationHistory")}
        />
      </Section>
      <Section title="Certifications" variant="card">
        <CertificationsSection
          certifications={draft.certificationsList}
          onUpdate={set("certificationsList")}
        />
      </Section>
      <Section title="Achievements" variant="card">
        <AchievementsSection
          achievements={draft.achievements}
          onUpdate={set("achievements")}
        />
      </Section>
      <SettingsSaveBar
        isSaving={save.isPending}
        isDirty={isDirty}
        onReset={() => setDraft(initial)}
      />
    </form>
  );
}
