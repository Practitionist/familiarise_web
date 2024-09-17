import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { OFFERINGS } from "@/constants/homePageData";

export default function OfferingsSection() {
  return (
    <section className="container mx-auto px-4 py-16 md:py-24 lg:py-32">
      <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-center mb-12">
        Check out our various offerings
      </h2>
      <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
        {OFFERINGS.map((offering) => (
          <Card key={offering.title} className="rounded-lg shadow-md transition-transform duration-300 hover:-translate-y-2">
            <CardHeader className="text-xl font-semibold">{offering.title}</CardHeader>
            <CardContent>
              <p className="text-gray-600">{offering.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}