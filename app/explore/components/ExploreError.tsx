"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** Shared segment error card for the explore surfaces — the per-segment
 *  error.tsx files are thin wrappers so the markup lives once. */
export default function ExploreError({
  error,
  reset,
  fallbackMessage,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
  fallbackMessage: string;
}>) {
  return (
    <div className="container mx-auto pt-24 py-8 px-4 min-h-[calc(100vh-400px)]">
      <Card className="max-w-2xl mx-auto text-center">
        <CardHeader>
          <CardTitle>Something went wrong!</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Always the route-specific copy: in production Next.js replaces a
              Server Component error's message with a generic string, so
              error.message never says anything useful to a visitor. The digest
              correlates a user report with the server-side log entry. */}
          <p className="text-muted-foreground">{fallbackMessage}</p>
          {error.digest && (
            <p className="mt-2 text-xs text-muted-foreground/70">
              Reference: {error.digest}
            </p>
          )}
        </CardContent>
        <CardFooter className="justify-center space-x-4">
          <Button variant="outline" onClick={() => reset()}>
            Try again
          </Button>
          <Button variant="outline" onClick={() => window.history.back()}>
            Go Back
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
