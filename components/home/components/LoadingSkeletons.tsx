import React from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export const ExpertLoadingSkeleton = React.memo(() => {
  return (
    <div className="flex-shrink-0 w-[280px]">
      <Card className="mx-3">
        <CardHeader>
          <div className="w-16 h-16 rounded-full bg-gray-200 animate-pulse mx-auto mb-3" />
          <div className="h-5 bg-gray-200 rounded animate-pulse w-3/4 mx-auto" />
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="h-4 bg-gray-200 rounded animate-pulse w-1/2 mx-auto" />
            <div className="h-3 bg-gray-200 rounded animate-pulse w-1/3 mx-auto" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
});

ExpertLoadingSkeleton.displayName = "ExpertLoadingSkeleton";

export const TestimonialLoadingSkeleton = React.memo(() => {
  const skeletonIds = Array.from(
    { length: 3 },
    (_, i) => `skeleton-${i}-${Math.random()}`,
  );
  
  return (
    <section className="py-16">
      <div className="container mx-auto px-4">
        <h2 className="text-3xl font-bold text-center mb-12">
          What Our Users Say
        </h2>
        <div className="flex justify-center">
          <div className="animate-pulse space-x-4 flex">
            {skeletonIds.map((id) => (
              <div
                key={id}
                className="w-[300px] h-[160px] bg-gray-200 rounded-lg flex-shrink-0"
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
});

TestimonialLoadingSkeleton.displayName = "TestimonialLoadingSkeleton";