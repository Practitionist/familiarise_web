"use client";

import { User } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { User2, GraduationCap, Sparkles } from "lucide-react";

interface AboutSectionProps {
  userDetails: User;
  consultantDetails: TConsultantProfile;
}

export function AboutSection({
  userDetails,
  consultantDetails,
}: AboutSectionProps) {
  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-6 md:p-8 space-y-6">
      {/* About */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center">
            <User2 className="w-4 h-4 text-zinc-600" />
          </div>
          <h3 className="text-lg font-semibold text-zinc-900">About</h3>
        </div>
        <p className="text-zinc-600 leading-relaxed">
          {consultantDetails.description || (
            <>
              {userDetails.name} is a seasoned{" "}
              {consultantDetails.headline || consultantDetails.domain.name} expert with{" "}
              {consultantDetails.experience} of experience in the{" "}
              {consultantDetails.domain.name} sector. They specialize in helping
              professionals and businesses achieve their goals through expert
              guidance and mentorship.
            </>
          )}
        </p>
      </div>

      {/* Education & Background */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center">
            <GraduationCap className="w-4 h-4 text-zinc-600" />
          </div>
          <h3 className="text-lg font-semibold text-zinc-900">
            Education & Background
          </h3>
        </div>
        <p className="text-zinc-600 leading-relaxed">
          {userDetails.name} has extensive experience across multiple
          industries, with a particular focus on{" "}
          {consultantDetails?.subDomains
            ?.map((domain: { name: string }) => domain.name)
            .join(", ") || consultantDetails.domain.name}
          . Their background includes working with diverse clients and
          organizations to deliver measurable results.
        </p>
      </div>

      {/* Skills & Specialties */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-zinc-600" />
          </div>
          <h3 className="text-lg font-semibold text-zinc-900">
            Skills & Specialties
          </h3>
        </div>
        <div className="flex flex-wrap gap-2">
          {consultantDetails.tags?.map((tag: { id: string; name: string }) => (
            <span
              key={tag.id}
              className="px-3 py-1.5 bg-zinc-100 text-zinc-700 text-sm font-medium rounded-full"
            >
              {tag.name}
            </span>
          ))}
          {(!consultantDetails.tags || consultantDetails.tags.length === 0) && (
            <p className="text-zinc-500 text-sm">
              Specializes in {consultantDetails.headline || consultantDetails.domain.name}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
