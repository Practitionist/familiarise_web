import React, { useEffect, useState } from 'react';
import { useToast } from "@/components/ui/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CalendarIcon, ClockIcon } from "lucide-react";
import { Class, Webinar } from '@prisma/client';

interface ClassesAndWebinarsProps {
  consultantId: string;
}

export const ClassesAndWebinars: React.FC<ClassesAndWebinarsProps> = ({ consultantId }) => {
  const [classes, setClasses] = useState<Class[]>([]);
  const [webinars, setWebinars] = useState<Webinar[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    const fetchClassesAndWebinars = async () => {
      setIsLoading(true);
      try {
        const classesResponse = await fetch(`/api/slots/appointments?type=class&consultantProfileId=${consultantId}`);
        const webinarsResponse = await fetch(`/api/slots/appointments?type=webinar&consultantProfileId=${consultantId}`);
        if (!classesResponse.ok || !webinarsResponse.ok) {
          throw new Error('Failed to fetch data');
        }

        const classesData = await classesResponse.json();
        const webinarsData = await webinarsResponse.json();

        setClasses(classesData.map((classItem: any) => classItem.class));
        setWebinars(webinarsData.map((webinar: any) => webinar.webinar));
      } catch (error) {
        console.error('Error fetching classes and webinars:', error);
        toast({
          title: "Error",
          description: "Failed to load classes and webinars",
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    };

    fetchClassesAndWebinars();
  }, [consultantId, toast]);

  if (isLoading) {
    return <div className="text-center py-10">Loading classes and webinars...</div>;
  }

  const renderClassCard = (classItem: Class) => (
    <Card key={classItem.id} className="hover:shadow-lg transition-shadow duration-300 flex flex-col h-full">
      <CardContent className="p-6 flex flex-col h-full">
        <h3 className="text-xl font-semibold mb-3">{classItem.title}</h3>
        <div className="flex items-center gap-3 text-sm text-gray-600 mb-4">
          <div className="flex items-center">
            <CalendarIcon className="w-4 h-4 mr-1" />
            {classItem.startDate instanceof Date ? classItem.startDate.toLocaleDateString() : 'Date TBA'}
          </div>
          <div className="flex items-center">
            <ClockIcon className="w-4 h-4 mr-1" />
            {classItem.startDate instanceof Date ? classItem.startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Time TBA'}
          </div>
        </div>
        <p className="text-gray-700 mb-4 line-clamp-3 flex-grow">{classItem.description}</p>
        <Button 
          variant="outline" 
          className="w-full mt-auto cursor-pointer transition-colors duration-300 hover:bg-black hover:text-white"
        >
          Register Now
        </Button>
      </CardContent>
    </Card>
  );

  const renderWebinarCard = (webinar: Webinar) => (
    <Card key={webinar.id} className="hover:shadow-lg transition-shadow duration-300 flex flex-col h-full">
      <CardContent className="p-6 flex flex-col h-full">
        <h3 className="text-xl font-semibold mb-3">{webinar.title}</h3>
        <div className="flex items-center gap-3 text-sm text-gray-600 mb-4">
          <div className="flex items-center">
            <CalendarIcon className="w-4 h-4 mr-1" />
            {webinar.scheduledAt instanceof Date ? webinar.scheduledAt.toLocaleDateString() : 'Date TBA'}
          </div>
          <div className="flex items-center">
            <ClockIcon className="w-4 h-4 mr-1" />
            {webinar.scheduledAt instanceof Date ? webinar.scheduledAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Time TBA'}
          </div>
        </div>
        <p className="text-gray-700 mb-4 line-clamp-3 flex-grow">{webinar.description}</p>
        <Button 
          variant="outline" 
          className="w-full mt-auto cursor-pointer transition-colors duration-300 hover:bg-black hover:text-white"
        >
          {webinar.scheduledAt instanceof Date && webinar.scheduledAt <= new Date() ? 'View Recording' : 'Register Now'}
        </Button>
      </CardContent>
    </Card>
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-12 space-y-12">
      <section>
        <h2 className="text-3xl font-bold mb-6">Upcoming Classes</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {classes.map(classItem => renderClassCard(classItem))}
        </div>
      </section>
      <section>
        <h2 className="text-3xl font-bold mb-6">Upcoming Webinars</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {webinars.map(webinar => renderWebinarCard(webinar))}
        </div>
      </section>
    </div>
  );
};