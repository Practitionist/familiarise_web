import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function SupportNotFound() {
  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
        <h1 className="text-fluid-3xl font-bold tracking-tight">
          Help page not found
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          The help page you are looking for moved or never existed. Browse the
          help center or contact support instead.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button asChild>
            <Link href="/support">Browse help center</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/contactus">Contact support</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
