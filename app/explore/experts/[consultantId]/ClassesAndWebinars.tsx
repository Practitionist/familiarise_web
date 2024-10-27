import React, { useEffect, useState } from 'react';
import { useToast } from "@/components/ui/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CalendarIcon, ClockIcon } from "lucide-react";
import { Class, Webinar} from '@prisma/client';
interface ClassesAndWebinarsProps {
  consultantId: string;
}

interface ExtendedClass extends Class {
  classPlan: {
    title: string;
    description: string;
    consultantProfile: {
      id: string;
    };
  };
}

interface ExtendedWebinar extends Webinar {
  webinarPlan: {
    title: string;
    description: string;
    consultantProfile: {
      id: string;
    };
    topics: Array<{
      id: string;
      name: string;
    }>;
  };
}

export const ClassesAndWebinars: React.FC<ClassesAndWebinarsProps> = ({ consultantId }) => {
  const [classPlans, setClassPlans] = useState<ExtendedClass[]>([]);
  const [webinarPlans, setWebinarPlans] = useState<ExtendedWebinar[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    const fetchClassAndWebinarPlans = async () => {
      setIsLoading(true);
      try {
        const classesResponse = await fetch(`/api/events/classes?consultantId=${consultantId}`);
        const webinarsResponse = await fetch(`/api/events/webinars?consultantId=${consultantId}`);
        
        if (!classesResponse.ok || !webinarsResponse.ok) {
          throw new Error('Failed to fetch data');
        }

        const classesData = await classesResponse.json();
        const webinarsData = await webinarsResponse.json();

        setClassPlans(classesData.data);
        setWebinarPlans(webinarsData.data);
      } catch (error) {
        console.error('Error fetching class and webinar plans:', error);
        toast({
          title: "Failed to load class and webinar plans",
          description: error instanceof Error ? error.message : 'An error occurred while fetching class and webinar plans',
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    };

    fetchClassAndWebinarPlans();
  }, [consultantId, toast]);

  if (isLoading) {
    return <div className="text-center py-10">Loading class and webinar plans...</div>;
  }

  const renderClassPlanCard = (classItem: ExtendedClass) => (
    <Card key={classItem.id} className="hover:shadow-lg transition-shadow duration-300 flex flex-col h-full">
      <CardContent className="p-6 flex flex-col h-full">
        <h3 className="text-xl font-semibold mb-3">{classItem.classPlan.title}</h3>
        <div className="flex items-center gap-3 text-sm text-gray-600 mb-4">
          <div className="flex items-center">
            <CalendarIcon className="w-4 h-4 mr-1" />
            {classItem.startDate ? new Date(classItem.startDate).toLocaleDateString() : 'Date TBA'}
          </div>
          <div className="flex items-center">
            <ClockIcon className="w-4 h-4 mr-1" />
            {classItem.startDate ? new Date(classItem.startDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Time TBA'}
          </div>
        </div>
        <p className="text-gray-700 mb-4 line-clamp-3 flex-grow">{classItem.classPlan.description}</p>
        <Button
          variant="outline"
          className="w-full mt-auto cursor-pointer transition-colors duration-300 hover:bg-black hover:text-white"
        >
          Register Now
        </Button>
      </CardContent>
    </Card>
  );

  const renderWebinarPlanCard = (webinar: ExtendedWebinar) => (
    <Card key={webinar.id} className="hover:shadow-lg transition-shadow duration-300 flex flex-col h-full">
      <CardContent className="p-6 flex flex-col h-full">
        <h3 className="text-xl font-semibold mb-3">{webinar.webinarPlan.title}</h3>
        <div className="flex items-center gap-3 text-sm text-gray-600 mb-4">
          <div className="flex items-center">
            <CalendarIcon className="w-4 h-4 mr-1" />
            {webinar.scheduledAt ? new Date(webinar.scheduledAt).toLocaleDateString() : 'Date TBA'}
          </div>
          <div className="flex items-center">
            <ClockIcon className="w-4 h-4 mr-1" />
            {webinar.scheduledAt ? new Date(webinar.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Time TBA'}
          </div>
        </div>
        <p className="text-gray-700 mb-4 line-clamp-3 flex-grow">{webinar.webinarPlan.description}</p>
        {webinar.webinarPlan.topics && webinar.webinarPlan.topics.length > 0 && (
          <div className="mb-4">
            <p className="text-sm font-semibold mb-2">Topics:</p>
            <div className="flex flex-wrap gap-2">
              {webinar.webinarPlan.topics.map(topic => (
                <span key={topic.id} className="text-xs bg-gray-100 px-2 py-1 rounded">
                  {topic.name}
                </span>
              ))}
            </div>
          </div>
        )}
        <Button
          variant="outline"
          className="w-full mt-auto cursor-pointer transition-colors duration-300 hover:bg-black hover:text-white"
        >
          {webinar.scheduledAt && new Date(webinar.scheduledAt) <= new Date() ? 'View Recording' : 'Register Now'}
        </Button>
      </CardContent>
    </Card>
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-12 space-y-12">
      <section>
        <h2 className="text-3xl font-bold mb-6">Class Plans</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {classPlans.map(classItem => renderClassPlanCard(classItem))}
        </div>
      </section>
      <section>
        <h2 className="text-3xl font-bold mb-6">Webinar Plans</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {webinarPlans.map(webinar => renderWebinarPlanCard(webinar))}
        </div>
      </section>
    </div>
  );
};
