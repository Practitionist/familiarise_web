"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function ClassNotFound() {
  return (
    <div className="container mx-auto pt-24 py-8 px-4 min-h-[calc(100vh-400px)]">
      <Card className="max-w-2xl mx-auto text-center">
        <CardHeader>
          <CardTitle>Class Not Found</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Sorry, the class you're looking for doesn't exist or may have been
            removed.
          </p>
        </CardContent>
        <CardFooter className="justify-center">
          <Button variant="outline" onClick={() => window.history.back()}>
            Go Back
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
