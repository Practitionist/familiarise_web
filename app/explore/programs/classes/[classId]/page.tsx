'use client'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { ClassNotFound } from "./ClassNotFound";
import { use } from 'react';

type ClassPlanWithRelations = Prisma.ClassPlanGetPayload<{
  include: {
    consultantProfile: {
      include: {
        user: true;
      };
    };
    topics: true;
    classContents: true;
  };
}>;

async function getClassPlan(classId: string): Promise<ClassPlanWithRelations | null> {
  const classPlan = await prisma.classPlan.findUnique({
    where: { id: classId },
    include: {
      consultantProfile: {
        include: {
          user: true,
        },
      },
      classContents: true,
      topics: true,
    },
  });
  return classPlan;
}


type Params = Promise<{ classId: string }>

export default function ClassDetailsPage(props: Readonly<{ params: Params }>) {
  const params = use(props.params)
  const classPlan = use(getClassPlan(params.classId));

  if (!classPlan) {
    return <ClassNotFound />;
  }

  return (
    <div className="container mx-auto pt-24 py-8 px-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="md:col-span-2">
          <h1 className="text-3xl font-bold mb-2">{classPlan.title}</h1>
          <p className="text-xl font-semibold mb-4">${classPlan.price} USD</p>
          
          <Card className="mb-8">
            <CardContent className="grid grid-cols-2 gap-4 p-6">
              <div className="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"></path><path d="M10 2v20"></path><path d="M13 5h4"></path><path d="M13 9h4"></path><path d="M13 13h4"></path><path d="M13 17h4"></path></svg>
                <span>Duration: {classPlan.durationInMonths} months</span>
              </div>
              <div className="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="m12 14 4-4"></path><path d="M3.34 19a10 10 0 1 1 17.32 0"></path></svg>
                <span>Calls per week: {classPlan.callsPerWeek}</span>
              </div>
              <div className="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                <span>Video meetings: {classPlan.videoMeetings}</span>
              </div>
              <div className="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>
                <span>Email support: {classPlan.emailSupport}</span>
              </div>
              <div className="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                <span>Language: {classPlan.language || 'Not specified'}</span>
              </div>
              <div className="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                <span>Material provided: {classPlan.materialProvided || 'Not specified'}</span>
              </div>
              <div className="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                <span>Max participants: {classPlan.maxParticipants}</span>
              </div>
              <div className="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                <span>Certificate: {classPlan.certificateProvided ? 'Provided' : 'Not provided'}</span>
              </div>
            </CardContent>
          </Card>

          <h2 className="text-2xl font-semibold mb-4">Course Description</h2>
          <p className="mb-8 whitespace-pre-line">{classPlan.description}</p>

          <h2 className="text-2xl font-semibold mb-4">Course Content</h2>
          <Accordion type="single" collapsible className="w-full">
            {classPlan.classContents.map((content, index) => (
              <AccordionItem key={content.id} value={`item-${index + 1}`}>
                <AccordionTrigger>{content.title}</AccordionTrigger>
                <AccordionContent>
                  <p>{content.description}</p>
                  <p>Hours allotted: {content.hoursAllotted}</p>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>

        <div>
          <Card>
            <CardHeader>
              <CardTitle>Course Information</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4">A course by {classPlan.consultantProfile?.user?.name || 'Unknown Instructor'}</p>
              {classPlan.topics.map((topic) => (
                <Badge key={topic.id} className="mr-2 mb-2">{topic.name}</Badge>
              ))}
            </CardContent>
            <CardFooter className="flex flex-col gap-4">
              <form action="/api/checkout/class" method="POST" className="w-full">
                <input type="hidden" name="classId" value={classPlan.id} />
                <Button type="submit" className="w-full">
                  Enroll in course
                </Button>
              </form>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}
