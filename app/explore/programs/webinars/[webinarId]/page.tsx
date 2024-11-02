'use client'

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { use } from 'react';
import { WebinarNotFound } from "./WebinarNotFound";

type WebinarPlanWithRelations = Prisma.WebinarPlanGetPayload<{
  include: {
    consultantProfile: {
      include: {
        user: true;
      };
    };
    topics: true;
  };
}>;

async function getWebinarPlan(webinarId: string): Promise<WebinarPlanWithRelations | null> {
  const webinarPlan = await prisma.webinarPlan.findUnique({
    where: { id: webinarId },
    include: {
      consultantProfile: {
        include: {
          user: true,
        },
      },
      topics: true,
    },
  });
  return webinarPlan;
}


type Params = Promise<{ webinarId: string }>

export default function WebinarPage(props: Readonly<{ params: Params }>) {
  const params = use(props.params)
  const webinarPlan = use(getWebinarPlan(params.webinarId));

  if (!webinarPlan) {
    return <WebinarNotFound />;
  }

  return (
    <div className="container mx-auto pt-24 py-8 px-4">
      <div className="max-w-3xl mx-auto">
        <Card className="bg-white shadow-xl">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{webinarPlan.title}</CardTitle>
            <CardDescription className="text-xl">
              Duration: {webinarPlan.durationInHours} hours
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mt-4">
              <h3 className="text-lg font-medium">Speaker</h3>
              <p className="mt-1 text-muted-foreground">{webinarPlan.consultantProfile?.user?.name || 'Unknown Speaker'}</p>
            </div>
            <div className="mt-6">
              <h3 className="text-lg font-medium">About This Webinar</h3>
              <p className="mt-1 text-muted-foreground whitespace-pre-line">{webinarPlan.description}</p>
            </div>
            <div className="mt-6">
              <h3 className="text-lg font-medium">Topics</h3>
              <div className="mt-1 flex flex-wrap gap-2">
                {webinarPlan.topics.map((topic) => (
                  <span key={topic.id} className="inline-flex items-center rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-700/10">
                    {topic.name}
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-6">
              <h3 className="text-lg font-medium">Additional Information</h3>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Language</p>
                  <p className="font-medium">{webinarPlan.language || 'Not specified'}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Level</p>
                  <p className="font-medium">{webinarPlan.level || 'Not specified'}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Prerequisites</p>
                  <p className="font-medium">{webinarPlan.prerequisites || 'None'}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Materials</p>
                  <p className="font-medium">{webinarPlan.materialProvided || 'None'}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Max Participants</p>
                  <p className="font-medium">{webinarPlan.maxParticipants}</p>
                </div>
              </div>
            </div>
            <div className="mt-6">
              <h3 className="text-lg font-medium">Price</h3>
              <p className="mt-1 text-2xl font-semibold">${webinarPlan.price.toFixed(2)}</p>
            </div>
          </CardContent>
          <CardFooter>
            <form action="/api/checkout/webinar" method="POST" className="w-full">
              <input type="hidden" name="webinarId" value={webinarPlan.id} />
              <Button type="submit" className="w-full">
                Register Now
              </Button>
            </form>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
