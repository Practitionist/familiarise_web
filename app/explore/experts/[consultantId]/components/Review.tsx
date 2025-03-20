import { Avatar } from "@/components/ui/avatar";

import { fetchConsulteeDetails, fetchUserDetails } from "@/lib/user";

import { ConsultantReview } from "@prisma/client";
import { StarIcon } from "lucide-react";
import React, { useEffect, useState } from "react";

const Review: React.FC<Readonly<ConsultantReview>> = ({
  consulteeProfileId,
  createdAt,
  rating,
  reviewDescription,
}) => {
  const [reviewerName, setReviewerName] = useState<string>(consulteeProfileId);

  useEffect(() => {
    const fetchReviewerName = async () => {
      try {
        const consulteeData = await fetchConsulteeDetails(consulteeProfileId);
        if (consulteeData.userId) {
          const userData = await fetchUserDetails(consulteeData.userId);
          if (userData.name) {
            setReviewerName(userData.name);
          }
        }
      } catch (err) {
        console.error("Error fetching reviewer name:", err);
      }
    };

    fetchReviewerName();
  }, [consulteeProfileId]);

  return (
    <div className="flex items-start space-x-4 p-4 bg-white rounded-lg shadow-sm">
      <Avatar className="w-10 h-10" />
      <div className="flex-1">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="text-md font-semibold text-gray-800">
              {reviewerName}
            </h4>
            <p className="text-xs text-gray-500">
              {new Date(createdAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex items-center">
            {[...Array(5)].map((_, i) => (
              <StarIcon
                key={`star-${rating}-${i}`}
                className={`w-4 h-4 ${i < rating ? "text-yellow-400" : "text-gray-200"}`}
              />
            ))}
          </div>
        </div>
        <p className="text-sm text-gray-600 leading-relaxed">
          {reviewDescription}
        </p>
      </div>
    </div>
  );
};

export default Review;
