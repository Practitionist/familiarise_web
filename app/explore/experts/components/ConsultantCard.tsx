"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

export function ConsultantCard({ consultant, metadata }: ConsultantCardProps) {
  const router = useRouter();

  return (
    <div className="border border-gray-200 rounded-lg p-4 flex items-start justify-between space-x-4 dark:border-gray-800">
      <div
        className="flex items-start space-x-4 cursor-pointer"
        onClick={() => router.push(`/explore/experts/${consultant.id}`)}
      >
        <Image
          alt={`Portrait of ${consultant.user.name}`}
          className="rounded-full overflow-hidden"
          height="80"
          src={consultant.user.image || "/placeholder.svg"}
          style={{ aspectRatio: "80/80", objectFit: "cover" }}
          width="80"
        />
        <div className="space-y-2">
          <div className="flex items-center space-x-2">
            <h3 className="font-semibold text-lg">{consultant.user.name}</h3>
            {consultant.user.email && (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                @{consultant.user.email.split("@")[0]}
              </span>
            )}
          </div>
          <div className="text-sm space-y-2">
            <p className="text-black dark:text-black">{consultant.description}</p>
            <div className="flex flex-wrap gap-2">
              <span className="text-black dark:text-black">
                Experience: {consultant.experience}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="text-black dark:text-black">
                Specialization: {consultant.specialization}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="text-black dark:text-black">
                Qualifications: {consultant.qualifications}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="text-black dark:text-black">Domain:</span>
              <span className="bg-gray-200 text-black dark:bg-gray-700 dark:text-white px-2 py-1 rounded-full">
                {consultant.domain.name}
              </span>
              <span className="text-black dark:text-black">Subdomains:</span>
              {consultant.subDomains.map((sd) => (
                <span
                  key={sd.id}
                  className="bg-gray-200 text-black dark:bg-gray-700 dark:text-white px-2 py-1 rounded-full"
                >
                  {sd.name}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="text-black dark:text-black">Tags:</span>
              {consultant.tags.map((t) => (
                <span
                  key={t.id}
                  className="bg-white text-black border border-black px-2 py-1 rounded-full"
                >
                  {t.name}
                </span>
              ))}
            </div>
            <div className="flex items-center space-x-2 text-black dark:text-black">
              <StarIcon className="w-4 h-4" />
              <span>
                {consultant.rating.toFixed(1)} ({consultant.reviews?.length || 0}{" "}
                reviews)
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="flex">
        <div className="bg-card rounded-lg shadow-lg w-[320px] mr-4">
          {consultant.subscriptionPlans &&
          consultant.subscriptionPlans.length > 0 ? (
            <Tabs defaultValue="1" className="w-full">
              <TabsList className="flex border-b">
                {consultant.subscriptionPlans
                  .slice()
                  .sort((a, b) => a.durationInMonths - b.durationInMonths)
                  .map((plan) => (
                    <TabsTrigger
                      key={plan.id}
                      value={plan.durationInMonths.toString()}
                      className="flex-1 data-[state=active]:bg-black data-[state=active]:text-white rounded-md transition-all duration-200 ease-in-out"
                    >
                      {(() => {
                        switch (plan.durationInMonths) {
                          case 1:
                            return "1 Month";
                          case 3:
                            return "3 Months";
                          case 6:
                            return "6 Months";
                          case 12:
                            return "12 Months";
                          default:
                            return `${plan.durationInMonths} Months`;
                        }
                      })()}
                    </TabsTrigger>
                  ))}
              </TabsList>
              {consultant.subscriptionPlans
                .slice()
                .sort((a, b) => a.durationInMonths - b.durationInMonths)
                .map((plan) => (
                  <TabsContent
                    key={plan.id}
                    value={plan.durationInMonths.toString()}
                  >
                    <Card className="rounded-b-lg">
                      <CardContent className="grid gap-4 p-6">
                        <div className="flex items-center justify-between">
                          <div className="text-4xl font-bold">
                            ${plan.price / 100}
                          </div>
                          <div className="text-muted-foreground">
                            {(() => {
                              switch (plan.durationInMonths) {
                                case 1:
                                  return "1 month";
                                case 3:
                                  return "3 months";
                                case 6:
                                  return "6 months";
                                case 12:
                                  return "12 months";
                                default:
                                  return `${plan.durationInMonths} months`;
                              }
                            })()}
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <div>Calls per week</div>
                          <div className="font-medium">{plan.callsPerWeek}</div>
                        </div>
                        <div className="flex items-center justify-between">
                          <div>Email support</div>
                          <div className="font-medium">{plan.emailSupport}</div>
                        </div>
                        <div className="flex items-center justify-between">
                          <div>Video meetings</div>
                          <div className="font-medium">
                            {plan.videoMeetings} per month
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </TabsContent>
                ))}
            </Tabs>
          ) : (
            <div className="flex items-center justify-center h-full p-6 text-muted-foreground">
              <p className="text-center">
                No subscription plans available at the moment.
              </p>
            </div>
          )}
        </div>
        <div className="flex flex-col items-center space-y-2 pt-5 justify-start">
          <Button className="w-[140px]" variant="outline">
            Book a Free Trial
          </Button>
          <Button className="w-[140px]" variant="outline">
            Book a Session
          </Button>
          <Button className="w-[140px]" variant="outline">
            Book Mentorship
          </Button>
        </div>
      </div>
    </div>
  );
}
