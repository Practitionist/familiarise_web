import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { EXPERTS } from "@/constants/homePageData";

export default function FeaturedExpertsSection() {
  return (
    <section className="w-full py-12 md:py-24 lg:py-32 bg-gray-100">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold tracking-tighter">
            Meet our Featured Experts
          </h2>
          <p className="mt-4 mx-auto max-w-[700px] text-gray-500 md:text-xl">
            We have a diverse team of experts ready to share their
            knowledge and expertise with you.
          </p>
          <Button className="mt-8 dark:bg-gray-800 text-white hover:bg-gray-700 transition-colors duration-300">
            View All Experts
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-8">
          {EXPERTS.map((expert, index) => (
            <Card key={index} className="hover:shadow-xl transition-shadow duration-300 hover:-translate-y-1">
              <CardHeader>
                <Avatar className="mx-auto mb-4" />
                <h3 className="text-lg font-bold">{expert.name}</h3>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Expert in {expert.expertise}.
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}