import { StarIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { User } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";

interface ProfileHeaderProps {
  userDetails: User;
  consultantDetails: TConsultantProfile;
}

export function ProfileHeader({
  userDetails,
  consultantDetails,
}: ProfileHeaderProps) {
  return (
    <div className="space-y-8">
      <div className="flex items-center space-x-6">
        <div className="flex flex-col">
          <h2 className="text-3xl font-semibold text-white">{userDetails.name}</h2>
          <div className="flex items-center mt-2">
            {[...Array(5)].map((_, i) => (
              <StarIcon
                key={`${i}-${consultantDetails.rating}`}
                className={`w-5 h-5 ${i < consultantDetails.rating ? "text-yellow-400 fill-yellow-400" : "text-gray-600"}`}
              />
            ))}
            <span className="ml-2 text-sm text-gray-200">
              ({consultantDetails.rating})
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <Badge variant="outline" className="bg-gray-700/50 border-gray-600/50 text-gray-200">{consultantDetails.specialization}</Badge>
      </div>
    </div>
  );
}
