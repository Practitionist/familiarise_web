import Link from "next/link";
import Image from "next/image";
import { Building2, Users, Globe } from "lucide-react";
import prisma from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
} from "@/components/ui/card";

export const metadata = {
  title: "Explore Companies | Familiarise",
  description:
    "Browse consulting organizations and agencies on Familiarise. Find expert teams for your needs.",
};

export default async function ExploreCompaniesPage() {
  const orgs = await prisma.organizationProfile.findMany({
    where: {
      kind: { in: ["PROVIDER", "HYBRID"] },
      status: "ACTIVE",
    },
    include: {
      organization: { select: { id: true, name: true, slug: true, logo: true } },
      _count: {
        select: {
          members: {
            where: { role: "ORG_CONSULTANT", status: "ACTIVE" },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <main className="min-h-screen bg-white">
      {/* Hero */}
      <div className="bg-gradient-to-br from-zinc-50 to-zinc-100 border-b">
        <div className="max-w-5xl mx-auto px-6 py-12">
          <div className="flex items-center gap-3 mb-3">
            <Building2 className="h-6 w-6 text-zinc-600" />
            <h1 className="text-2xl font-bold text-zinc-900">
              Consulting Organizations
            </h1>
          </div>
          <p className="text-zinc-600 max-w-xl">
            Browse agencies and organizations that host expert consultants on
            Familiarise. Each organization has a curated team of verified professionals.
          </p>
        </div>
      </div>

      {/* Grid */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        {orgs.length === 0 ? (
          <p className="text-zinc-500 text-center py-16">
            No organizations listed yet. Check back soon!
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {orgs.map((org) => (
              <Link
                key={org.id}
                href={`/org/${org.organization.slug}`}
              >
                <Card className="h-full hover:border-zinc-400 transition-colors cursor-pointer">
                  <CardContent className="p-5">
                    <div className="flex items-start gap-3">
                      {(org.logo || org.organization.logo) ? (
                        <Image
                          src={org.logo || org.organization.logo || ""}
                          alt={org.organization.name}
                          width={48}
                          height={48}
                          className="rounded-lg border bg-white"
                        />
                      ) : (
                        <div className="w-12 h-12 rounded-lg bg-zinc-100 flex items-center justify-center text-zinc-400">
                          <Building2 className="h-5 w-5" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-zinc-900 truncate">
                          {org.organization.name}
                        </p>
                        {org.industry && (
                          <Badge
                            variant="secondary"
                            className="mt-1 text-[10px]"
                          >
                            {org.industry}
                          </Badge>
                        )}
                        {org.description && (
                          <p className="text-xs text-zinc-500 mt-1.5 line-clamp-2">
                            {org.description}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 mt-4 pt-3 border-t text-xs text-zinc-400">
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" />
                        {org._count.members} consultant
                        {org._count.members !== 1 ? "s" : ""}
                      </span>
                      {org.website && (
                        <span className="flex items-center gap-1">
                          <Globe className="h-3.5 w-3.5" />
                          Website
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
