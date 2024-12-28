import { User } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";

interface AboutSectionProps {
  userDetails: User;
  consultantDetails: TConsultantProfile;
}

export function AboutSection({
  userDetails,
  consultantDetails,
}: AboutSectionProps) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-semibold mb-2">About</h3>
        <p className="text-gray-600">
          {userDetails.name} is a seasoned {consultantDetails.specialization}{" "}
          with {consultantDetails.experience} of experience in the{" "}
          {consultantDetails.domain.name} sector.
        </p>
      </div>

      <div>
        <h3 className="text-xl font-semibold mb-2">Education & Background</h3>
        <p className="text-gray-600">
          {userDetails.name} has experience across multiple industries, with a
          particular focus on{" "}
          {consultantDetails?.subDomains
            ?.map((domain: { name: string }) => domain.name)
            .join(", ")}
          .
        </p>
      </div>

      <div>
        <h3 className="text-xl font-semibold mb-2">Skills & Specialties</h3>
        <p className="text-gray-600">
          {userDetails.name} focuses on{" "}
          {consultantDetails.tags
            ?.map((tag: { name: string }) => tag.name)
            .join(", ")}
          .
        </p>
      </div>
    </div>
  );
}
