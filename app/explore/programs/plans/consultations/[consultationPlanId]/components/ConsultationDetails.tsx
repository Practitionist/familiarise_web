"use client";

import Link from "next/link";
import Image from "next/image";
import {
  ArrowLeft,
  CalendarDays,
  Clock,
  GraduationCap,
  Globe,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PlanDetailBody } from "../../../components/PlanDetailBody";
import { FeatureItem } from "../../../components/FeatureItem";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { useCurrency } from "@/hooks/useCurrency";
import { MobileBookingBar } from "@/app/explore/components/MobileBookingBar";
import type { getConsultationPlanDetail } from "@/lib/data/plan-details";

type ConsultationPlanDetail = NonNullable<
  Awaited<ReturnType<typeof getConsultationPlanDetail>>
>;

export function ConsultationDetails({
  plan,
}: Readonly<{ plan: ConsultationPlanDetail }>) {
  const { formatPrice } = useCurrency();
  const consultant = plan.consultantProfile;
  const expertName = consultant?.user?.name ?? "This expert";

  return (
    <main className="explore-detail min-h-screen">
      <div className="explore-detail-shell py-8 md:py-12">
        <Link
          href="/explore/experts"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to experts
        </Link>

        <div className="explore-hero mb-10 rounded-3xl px-7 py-10 text-white md:px-12 md:py-14">
          <Badge className="mb-4 border border-white/20 bg-white/10 text-white hover:bg-white/10">
            1:1 consultation
          </Badge>
          <h1 className="max-w-4xl text-fluid-4xl font-semibold tracking-tight text-white">
            {plan.title}
          </h1>
          {plan.subtitle && (
            <p className="mt-4 max-w-3xl text-base leading-relaxed text-zinc-300 md:text-lg">
              {plan.subtitle}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 pb-16">
          <div className="space-y-8 lg:col-span-2">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <FeatureItem
                icon={<Clock className="h-5 w-5" />}
                label="Duration"
                value={`${plan.durationInHours} hour${plan.durationInHours !== 1 ? "s" : ""}`}
              />
              <FeatureItem
                icon={<CalendarDays className="h-5 w-5" />}
                label="Format"
                value="One-to-one"
              />
              <FeatureItem
                icon={<GraduationCap className="h-5 w-5" />}
                label="Level"
                value={planLevelLabel(plan.level)}
              />
              <FeatureItem
                icon={<Globe className="h-5 w-5" />}
                label="Language"
                value={plan.language}
              />
            </div>

            <PlanDetailBody
              aboutHeading="About this consultation"
              description={plan.description}
              learningOutcomes={plan.learningOutcomes}
              targetAudience={plan.targetAudience}
              whatsIncluded={plan.whatsIncluded}
              prerequisites={plan.prerequisites}
              materialProvided={plan.materialProvided}
              faqs={plan.faqs}
              topics={plan.topics}
            />
          </div>

          {/* Sidebar: price + booking */}
          <div className="lg:col-span-1">
            <Card
              id="consultation-booking"
              className="explore-booking-target rounded-2xl border-border shadow-sm lg:sticky lg:top-[calc(var(--maintenance-banner-height,0px)+var(--header-height,5rem)+1rem)]"
            >
              <CardContent className="p-6 space-y-5">
                <div>
                  <p className="text-3xl font-bold text-foreground">
                    {formatPrice(plan.price)}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    for one {plan.durationInHours}-hour session
                  </p>
                </div>

                {/* Slot selection lives on the expert page, which owns the
                    availability calendar; this deep-links straight to it. */}
                <Button asChild className="w-full h-11">
                  <Link href={`/explore/experts/${consultant?.id}?action=book`}>
                    Pick a slot
                  </Link>
                </Button>

                {consultant && (
                  <div className="pt-5 border-t border-border">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground mb-3">
                      Your expert
                    </p>
                    <Link
                      href={`/explore/experts/${consultant.id}`}
                      className="flex items-center gap-3 group"
                    >
                      <div className="relative w-11 h-11 flex-shrink-0">
                        <Image
                          src={
                            consultant.user?.image ?? "/placeholder-user.jpg"
                          }
                          alt={expertName}
                          fill
                          className="rounded-xl object-cover"
                        />
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-sm text-foreground group-hover:underline truncate">
                          {expertName}
                        </p>
                        {consultant.headline && (
                          <p className="text-xs text-muted-foreground truncate">
                            {consultant.headline}
                          </p>
                        )}
                      </div>
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
      <MobileBookingBar
        targetId="consultation-booking"
        context="One-to-one consultation"
        label={formatPrice(plan.price)}
      />
    </main>
  );
}
