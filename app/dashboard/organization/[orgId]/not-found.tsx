import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * App-router not-found boundary for pages under `/dashboard/organization/[orgId]`.
 *
 * A sub-page calls `notFound()` when the viewer's role or the org's
 * capabilities do not include it, so the copy is a neutral access message. An
 * unknown or foreign org id is rejected by the layout and lands on
 * `app/dashboard/not-found.tsx` instead.
 */
export default function OrgDashboardNotFound() {
  return (
    <div className="container mx-auto pt-24 py-8 px-4 min-h-[calc(100vh-400px)]">
      <Card className="max-w-2xl mx-auto text-center">
        <CardHeader>
          <CardTitle>You don&apos;t have access to this page</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            This page isn&apos;t available for your role in this organization,
            or it no longer exists. Ask an owner if you need access.
          </p>
        </CardContent>
        <CardFooter className="justify-center space-x-4">
          <Button variant="outline" asChild>
            <Link href="/dashboard">Back to your dashboard</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
