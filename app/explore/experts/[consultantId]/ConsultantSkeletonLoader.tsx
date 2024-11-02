import React, { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

export const ConsultantSkeletonLoader: React.FC = () => {
  const [loadingText, setLoadingText] = useState(
    "Please wait while we are fetching consultant details",
  );

  useEffect(() => {
    const dots = [".", "..", "..."];
    let dotIndex = 0;

    const interval = setInterval(() => {
      setLoadingText((prevText) => {
        const baseText = "Please wait while we are fetching consultant details";
        return `${baseText}${dots[dotIndex]}`;
      });
      dotIndex = (dotIndex + 1) % dots.length;
    }, 500);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col justify-center items-center min-h-screen">
      <div className="text-2xl font-semibold mb-8 text-center animate-pulse">
        {loadingText}
      </div>
      <div className="flex justify-center w-full max-w-6xl">
        <div className="flex flex-col w-1/2">
          <Skeleton className="h-8 w-32 mb-2" />
          <Skeleton className="h-10 w-64 mb-4" />
          <Skeleton className="h-6 w-full mb-4" />
          <Skeleton className="h-40 w-full mb-6" />
          <Skeleton className="h-6 w-full mb-2" />
          <Skeleton className="h-24 w-full mb-6" />
          <Skeleton className="h-6 w-full mb-2" />
          <Skeleton className="h-24 w-full" />
        </div>
        <div className="flex flex-col items-center w-1/4 ml-10">
          <Skeleton className="h-64 w-64 rounded-full mb-6" />
          <Skeleton className="h-80 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
};
