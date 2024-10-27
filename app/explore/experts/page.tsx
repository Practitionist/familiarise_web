"use client";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Domain, SubDomain, Tag, ConsultationPlan, SubscriptionPlan, WebinarPlan, ClassPlan } from "@prisma/client";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface MetaData {
  domains: Domain[];
  subdomains: SubDomain[];
  tags: Tag[];
}

interface Consultant {
  id: string;
  description: string;
  qualifications: string;
  specialization: string;
  experience: string;
  rating: number;
  domainId: string;
  scheduleType: string;
  userId: string;
  reviews: any[];
  slotsOfAvailabilityWeekly: any[];
  slotsOfAvailabilityCustom: any[];
  consultationPlans: ConsultationPlan[];
  subscriptionPlans: SubscriptionPlan[];
  webinarPlans: WebinarPlan[];
  classPlans: ClassPlan[];
  user: {
    id: string;
    name: string;
    email: string;
    image: string;
  };
}

function FindExperts() {
  const [metadata, setMetadata] = useState<MetaData | null>(null);
  const [consultants, setConsultants] = useState<Consultant[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [experienceYears, setExperienceYears] = useState(0);
  const [pricing, setPricing] = useState(0);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [selectedSubdomain, setSelectedSubdomain] = useState<string | null>(null);

  const router = useRouter();

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const [metaResponse, consultantsResponse] = await Promise.all([
          fetch("/api/user/consultants/meta"),
          fetch("/api/user/consultants")
        ]);
        const metaData = await metaResponse.json();
        const consultantsData = await consultantsResponse.json();

        setMetadata(metaData.data);
        setConsultants(consultantsData.data);
      } catch (error) {
        console.error("Error fetching data:", error);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, []);

  const handleTagSelect = (tag: string) => {
    if (!selectedTags.includes(tag)) {
      setSelectedTags([...selectedTags, tag]);
    }
    setIsDropdownOpen(false);
    setSearchTerm("");
  };

  const handleTagRemove = (tag: string) => {
    setSelectedTags(selectedTags.filter((t) => t !== tag));
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
    setIsDropdownOpen(true);
  };

  const filteredTags = metadata?.tags.filter(
    (tag) =>
      tag.name.toLowerCase().includes(searchTerm.toLowerCase()) &&
      !selectedTags.includes(tag.name)
  ) || [];

  if (isLoading) {
    return <div>Loading experts...</div>;
  }

  return (
    <div key="1" className="w-full px-4 py-6 space-y-6 md:px-6 md:py-12">
      <div className="flex flex-col space-y-2">
        <h1 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
          Find an Expert
        </h1>
        <p className="text-gray-500 grid-rows-2 dark:text-gray-400">
          Search for experts in various fields. Enter keywords to find experts
          in specific areas.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between dark:border-gray-800">
          <div>
            <label
              className="block mb-2 text-sm font-medium text-black dark:text-black"
              htmlFor="domain"
            >
              Domain
            </label>
            <Select
              onValueChange={(value) => setSelectedDomain(value)}
            >
              <SelectTrigger id="domain" aria-label="Select domain">
                <SelectValue
                  placeholder="Select domain"
                />
              </SelectTrigger>
              <SelectContent>
                {metadata?.domains.map((domain) => (
                  <SelectItem key={domain.id} value={domain.id} className="bg-slate-200 text-black">
                    {domain.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-4">
            <label
              className="block mb-2 text-sm font-medium text-black dark:text-black"
              htmlFor="subdomain"
            >
              Subdomain
            </label>
            <Select
              disabled={!selectedDomain}
              onValueChange={(value) => setSelectedSubdomain(value)}
            >
              <SelectTrigger id="subdomain" aria-label="Select subdomain">
                <SelectValue
                  placeholder="Select subdomain"
                />
              </SelectTrigger>
              <SelectContent>
                {metadata?.subdomains
                  .filter((subdomain) => subdomain.domainId === selectedDomain)
                  .map((subdomain) => (
                    <SelectItem key={subdomain.id} value={subdomain.id} className="bg-slate-200 text-black">
                      {subdomain.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between bg-white text-black dark:border-gray-800">
          <div>
            <label
              className="block mb-2 text-sm font-medium text-black"
              htmlFor="tags"
            >
              Tags
            </label>
            <div className="relative">
              <input
                className="bg-white border border-gray-300 text-black text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5"
                id="tags"
                placeholder="Search tags..."
                type="text"
                value={searchTerm}
                onChange={handleInputChange}
                onFocus={() => setIsDropdownOpen(true)}
              />
              {isDropdownOpen && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg">
                  <ul className="py-1 overflow-auto max-h-60">
                    {filteredTags.map((tag) => (
                      <li
                        key={tag.id}
                        className="px-3 py-2 hover:bg-gray-100 cursor-pointer text-black"
                        onClick={() => handleTagSelect(tag.name)}
                      >
                        {tag.name}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {selectedTags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-black"
                >
                  {tag}
                  <button
                    className="ml-2 inline-flex h-4 w-4 items-center justify-center rounded-full text-gray-400 hover:text-gray-500"
                    onClick={() => handleTagRemove(tag)}
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between dark:border-gray-800">
          <div>
            <label
              className="block mb-2 text-sm font-medium text-black"
              htmlFor="experience"
            >
              Experience Years
            </label>
            <input
              type="range"
              min="0"
              max="30"
              value={experienceYears}
              onChange={(e) => setExperienceYears(Number(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
            />
            <div className="flex justify-between mt-2 text-sm text-gray-600">
              <span>0</span>
              <span>15</span>
              <span>30+</span>
            </div>
            <div className="text-center mt-2 font-semibold text-lg">
              {experienceYears === 30 ? "30+" : experienceYears} years
            </div>
          </div>
        </div>
        <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between dark:border-gray-800">
          <div>
            <label
              className="block mb-2 text-sm font-medium text-black"
              htmlFor="pricing"
            >
              Pricing (per hour)
            </label>
            <input
              type="range"
              min="0"
              max="1000"
              step="10"
              value={pricing}
              onChange={(e) => setPricing(Number(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
            />
            <div className="flex justify-between mt-2 text-sm text-gray-600">
              <span>$0</span>
              <span>$500</span>
              <span>$1000+</span>
            </div>
            <div className="text-center mt-2 font-semibold text-lg">
              ${pricing === 1000 ? "1000+" : pricing}
            </div>
          </div>
        </div>
      </div>
      <div className="border border-gray-200 rounded-lg grid items-center p-2 dark:border-gray-800">
        <Input
          className="appearance-none w-full border-0 focus:outline-none placeholder-gray-500 dark:placeholder-gray-400"
          placeholder="Search for experts"
          type="search"
        />
      </div>
      <div className="space-y-4">
        {metadata?.domains.map((domain) => {
          const domainConsultants = consultants?.filter((consultant) => consultant.domainId === domain.id) ?? [];

          return (
            <div key={domain.id} className="space-y-4">
              <h2 className="text-2xl font-bold">{domain.name}</h2>
              {domainConsultants.length > 0 ? (
                domainConsultants.map((consultant) => (
                  console.log(consultant),
                  <div
                    key={consultant.id}
                    className="border border-gray-200 rounded-lg p-4 flex items-start justify-between space-x-4 dark:border-gray-800"
                  >
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
                          <span className="text-sm text-gray-500 dark:text-gray-400">
                            @{consultant.user.email.split('@')[0]}
                          </span>
                        </div>
                        <div className="text-sm space-y-2">
                          <p className="text-black dark:text-black">{consultant.description}</p>
                          <div className="flex flex-wrap gap-2">
                            <span className="text-black dark:text-black">Experience: {consultant.experience}</span>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <span className="text-black dark:text-black">Specialization: {consultant.specialization}</span>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <span className="text-black dark:text-black">Qualifications: {consultant.qualifications}</span>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <span className="text-black dark:text-black">Domain:</span>
                            <span className="bg-gray-200 text-black dark:bg-gray-700 dark:text-white px-2 py-1 rounded-full">
                              {metadata?.domains.find(d => d.id === consultant.domainId)?.name}
                            </span>
                            <span className="text-black dark:text-black">Subdomains:</span>
                            {metadata?.subdomains.filter(sd => sd.domainId === consultant.domainId).map(sd => (
                              <span key={sd.id} className="bg-gray-200 text-black dark:bg-gray-700 dark:text-white px-2 py-1 rounded-full">{sd.name}</span>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <span className="text-black dark:text-black">Tags:</span>
                            {metadata?.tags.filter(t => t.domainId === consultant.domainId).map(t => (
                              <span key={t.id} className="bg-gray-200 text-black dark:bg-gray-700 dark:text-white px-2 py-1 rounded-full">{t.name}</span>
                            ))}
                          </div>
                          <div className="flex items-center space-x-2 text-black dark:text-black">
                            <StarIcon className="w-4 h-4" />
                            <span>{consultant.rating.toFixed(1)} ({consultant.reviews?.length || 0} reviews)</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex">
                      <div className="bg-card rounded-lg shadow-lg w-[320px] mr-4">
                        {consultant.subscriptionPlans && consultant.subscriptionPlans.length > 0 ? (
                          <Tabs defaultValue="1" className="w-full">
                            <TabsList className="flex border-b">
                              {Array.from(consultant.subscriptionPlans || [])
                                .sort((a, b) => a.durationInMonths - b.durationInMonths)
                                .map((plan: SubscriptionPlan) => (
                                  <TabsTrigger
                                    key={plan.id}
                                    value={plan.durationInMonths.toString()}
                                    className="flex-1 data-[state=active]:bg-black data-[state=active]:text-white rounded-md transition-all duration-200 ease-in-out"
                                  >
                                    {(() => {
                                      switch (plan.durationInMonths) {
                                        case 1: return '1 Month';
                                        case 3: return '3 Months';
                                        case 6: return '6 Months';
                                        case 12: return '12 Months';
                                        default: return `${plan.durationInMonths} Months`;
                                      }
                                    })()}
                                  </TabsTrigger>
                                ))}
                            </TabsList>
                            {Array.from(consultant.subscriptionPlans || [])
                              .sort((a, b) => a.durationInMonths - b.durationInMonths)
                              .map((plan: SubscriptionPlan) => (
                                <TabsContent key={plan.id} value={plan.durationInMonths.toString()}>
                                  <Card className="rounded-b-lg">
                                    <CardContent className="grid gap-4 p-6">
                                      <div className="flex items-center justify-between">
                                        <div className="text-4xl font-bold">${plan.price / 100}</div>
                                        <div className="text-muted-foreground">
                                          {(() => {
                                            switch (plan.durationInMonths) {
                                              case 1: return '1 month';
                                              case 3: return '3 months';
                                              case 6: return '6 months';
                                              case 12: return '12 months';
                                              default: return `${plan.durationInMonths} months`;
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
                                        <div className="font-medium">{plan.videoMeetings} per month</div>
                                      </div>
                                    </CardContent>
                                  </Card>
                                </TabsContent>
                              ))}
                          </Tabs>
                        ) : (
                          <div className="flex items-center justify-center h-full p-6 text-muted-foreground">
                            <p className="text-center">No subscription plans available at the moment.</p>
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
                ))
              ) : (
                <p className="text-gray-500">No consultants available in this domain at the moment.</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ExploreExperts() {
  return (
    <>
      <section className="w-full py-12 md:py-24 lg:py-32">
        <div className="space-y-12 px-4 md:px-6">
          <div className="flex flex-col items-center justify-center space-y-4 text-center">
            <div className="space-y-2">
              <div className="inline-block rounded-lg bg-black px-3 py-1 text-sm text-white">
                Featured Experts
              </div>
              <h2 className="text-3xl font-bold tracking-tighter sm:text-5xl">
                Top Consultants
              </h2>
              <p className="max-w-[900px] text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
                Discover the best of the best. Our top consultants are ready to
                help you with your business needs.
              </p>
            </div>
          </div>
          <div className="mx-auto grid items-start gap-8 sm:max-w-4xl sm:grid-cols-2 md:gap-12 lg:max-w-5xl lg:grid-cols-3">
            <Card>
              <CardHeader>
                <h3 className="text-lg font-bold">John Doe</h3>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Get help with your business strategy from a top consultant.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <h3 className="text-lg font-bold">Eliot</h3>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Get help with your product design from a top consultant.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <h3 className="text-lg font-bold">Macmillan</h3>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Get help with your marketing strategy from a top consultant.
                </p>
              </CardContent>
            </Card>
          </div>
          <div className="flex justify-center space-x-4">
            <Link
              className="inline-flex h-10 items-center justify-center rounded-md bg-slate-200 px-8 text-sm font-medium text-gray-900 shadow transition-colors hover:bg-slate-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-950 disabled:pointer-events-none disabled:opacity-50 dark:bg-slate-200 dark:text-gray-900 dark:hover:bg-slate-300 dark:focus-visible:ring-gray-300"
              href="#"
            >
              View All Experts
            </Link>
          </div>
        </div>
      </section>
      <FindExperts />

      <section className="w-full py-12 md:py-24 lg:py-32 bg-black dark:bg-black">
        <div className="grid items-center justify-center gap-4 px-4 text-center md:px-6">
          <div className="space-y-3">
            <h2 className="text-3xl font-bold tracking-tighter md:text-4xl/tight text-white">
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-gray-700 to-white">
                What Our Customers Say
              </span>
            </h2>
            <p className="mx-auto max-w-[600px] text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
              Hear from our valued customers about their experience with our
              experts.
            </p>
          </div>
          <div className="mx-auto w-full max-w-sm space-y-2">
            <Avatar className="w-12 h-12" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              &ldquo;The expert I consulted with was incredibly knowledgeable and helped me solve my business challenges quickly.&ldquo;
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              - Satisfied Client
            </p>
          </div>
        </div>
      </section>
    </>
  );
}

function XIcon(props: Readonly<React.SVGProps<SVGSVGElement>>) {
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
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function StarIcon(props: Readonly<React.SVGProps<SVGSVGElement>>) {
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