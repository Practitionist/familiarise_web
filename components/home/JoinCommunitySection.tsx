import { Button } from "@/components/ui/button";

export default function JoinCommunitySection() {
  return (
    <section className="w-full py-16 md:py-24 lg:py-32 bg-gray-100">
      <div className="container mx-auto px-4 md:px-6 text-center">
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tighter mb-4">
          Join our Community of Experts
        </h2>
        <p className="text-lg text-gray-600 md:text-xl max-w-[600px] mx-auto mb-8">
          Share your expertise with people who need it and grow your personal
          brand.
        </p>
        <Button className="w-full sm:w-auto bg-gray-900 text-white hover:bg-gray-800">
          Become an Expert
        </Button>
      </div>
    </section>
  );
}
