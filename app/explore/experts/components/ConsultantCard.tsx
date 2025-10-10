"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Domain, SubDomain, Tag } from "@prisma/client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { TConsultantProfile } from "@/types/consultant";

interface ConsultantCardProps {
  consultant: TConsultantProfile;
  metadata: {
    domains: Domain[];
    subdomains: SubDomain[];
    tags: Tag[];
  } | null;
}

function StarIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

const ConsultantInfo = ({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) => (
  <div className="flex flex-wrap gap-2 items-center">
    <span className="text-gray-200 font-medium">{label}:</span>
    <span className="text-white">{value || "Not specified"}</span>
  </div>
);

const TagBadge = ({ children }: { children: React.ReactNode }) => (
  <Badge
    variant="outline"
    className="px-3 py-1 text-sm bg-gray-700/50 border-gray-600/50 text-gray-200 hover:bg-gray-600/50 hover:border-gray-500/50 transition-colors"
  >
    {children}
  </Badge>
);

const SubscriptionPlanCard = ({ plan }: { plan: any }) => {
  const formatDuration = (months: number) => {
    switch (months) {
      case 1:
        return "1 month";
      case 3:
        return "3 months";
      case 6:
        return "6 months";
      case 12:
        return "1 year";
      default:
        return `${months} months`;
    }
  };

  return (
    <Card className="rounded-lg border-0 shadow-md hover:shadow-lg transition-shadow bg-gray-800/30 border-gray-700/50">
      <CardContent className="grid gap-4 p-6">
        <div className="flex items-center justify-between">
          <div className="text-3xl font-bold text-gray-100">${plan.price / 100}</div>
          <div className="text-gray-400 font-medium">
            {formatDuration(plan.durationInMonths)}
          </div>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-300">Calls per week</span>
            <span className="font-semibold text-gray-100">{plan.callsPerWeek}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-300">Email support</span>
            <span className="font-semibold text-gray-100 capitalize">
              {plan.emailSupport.toLowerCase()}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-300">Video meetings</span>
            <span className="font-semibold text-gray-100">
              {plan.videoMeetings} per month
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export function ConsultantCard({ consultant, metadata }: ConsultantCardProps) {
  const router = useRouter();

  const sortedPlans =
    consultant.subscriptionPlans
      ?.slice()
      .sort((a, b) => a.durationInMonths - b.durationInMonths) || [];

  return (
    <div className="bg-gradient-to-br from-gray-900/80 to-gray-800/60 border-2 border-gray-700/50 rounded-3xl shadow-lg hover:shadow-2xl hover:border-gray-500/70 transition-all duration-500 overflow-hidden backdrop-blur-sm hover:scale-[1.01]">
      <div className="p-6 flex flex-col lg:flex-row gap-6">
        {/* Left Section: Consultant Info */}
        <div
          className="flex-grow cursor-pointer space-y-4"
          onClick={() => router.push(`/explore/experts/${consultant.id}`)}
        >
          <div className="flex items-center gap-4">
            <div className="relative h-20 w-20 flex-shrink-0">
              <Image
                alt={`Portrait of ${consultant.user.name}`}
                className="rounded-full"
                src={consultant.user.image || "/placeholder-user.jpg"}
                fill
                style={{ objectFit: "cover" }}
              />
            </div>
            <div>
              <h3 className="text-xl font-semibold text-white">{consultant.user.name}</h3>
              {consultant.user.email && (
                <span className="text-gray-300">
                  @{consultant.user.email.split("@")[0]}
                </span>
              )}
              <div className="flex items-center gap-2 mt-1 text-sm">
                <StarIcon className="w-4 h-4 text-yellow-400 fill-yellow-400" />
                <span className="font-medium text-white">
                  {consultant.rating.toFixed(1)}
                </span>
                <span className="text-gray-300">
                  ({consultant.reviews?.length || 0} reviews)
                </span>
              </div>
            </div>
          </div>

          <p className="text-gray-200 leading-relaxed">
            {consultant.description}
          </p>

          <div className="space-y-2">
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-gray-200 font-medium">Experience:</span>
              <span className="text-white font-semibold">{consultant.experience ? `${consultant.experience} years` : "Not specified"}</span>
            </div>
            <ConsultantInfo
              label="Specialization"
              value={consultant.specialization}
            />
            <ConsultantInfo
              label="Qualifications"
              value={consultant.qualifications}
            />
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-gray-200 font-medium">Domain:</span>
              <TagBadge>{consultant.domain.name}</TagBadge>
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-gray-200 font-medium">Subdomains:</span>
              {consultant.subDomains.map((sd) => (
                <TagBadge key={`${consultant.id}-subdomain-${sd.id}`}>
                  {sd.name}
                </TagBadge>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-gray-200 font-medium">Tags:</span>
              {consultant.tags.map((t) => (
                <TagBadge key={`${consultant.id}-tag-${t.id}`}>
                  {t.name}
                </TagBadge>
              ))}
            </div>
          </div>
        </div>

        {/* Right Section: Subscription Plans & Actions */}
        <div className="flex-shrink-0 lg:w-[400px] space-y-4">
          <div className="bg-gray-800/30 border border-gray-700/50 rounded-lg p-4">
            {sortedPlans.length > 0 ? (
              <Tabs
                defaultValue={sortedPlans[0].durationInMonths.toString()}
                className="w-full"
              >
                <TabsList className="w-full mb-4 bg-gray-800/50 p-1 rounded-lg border border-gray-700/50">
                  {sortedPlans.map((plan) => (
                    <TabsTrigger
                      key={`${consultant.id}-tab-trigger-${plan.id}`}
                      value={plan.durationInMonths.toString()}
                      className="flex-1 data-[state=active]:bg-gray-700 data-[state=active]:text-gray-100 text-gray-400 rounded-md transition-all duration-200"
                    >
                      {plan.durationInMonths}{" "}
                      {plan.durationInMonths === 1 ? "Month" : "Months"}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {sortedPlans.map((plan) => (
                  <TabsContent
                    key={`${consultant.id}-tab-content-${plan.id}`}
                    value={plan.durationInMonths.toString()}
                  >
                    <SubscriptionPlanCard plan={plan} />
                  </TabsContent>
                ))}
              </Tabs>
            ) : (
              <div className="text-center text-gray-400 py-6">
                No subscription plans available at the moment.
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Button
              className="w-full bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-600 hover:to-gray-700 text-white border border-gray-600 shadow-md hover:shadow-lg transition-all"
            >
              Book a Free Trial
            </Button>
            <Button className="w-full bg-white hover:bg-gray-100 text-black shadow-md hover:shadow-lg transition-all font-semibold">
              Book a Session
            </Button>
            <Button
              className="w-full bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-600 hover:to-gray-700 text-white border border-gray-600 shadow-md hover:shadow-lg transition-all"
            >
              Book Mentorship
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
