// pages/webinar.tsx
import React from 'react';
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"

interface WebinarDetails {
  title: string;
  date: string;
  time: string;
  speaker: string;
  description: string;
  price: number;
}

const webinarDetails: WebinarDetails = {
  title: "Advanced React Patterns",
  date: "October 15, 2024",
  time: "2:00 PM - 4:00 PM EST",
  speaker: "Jane Doe",
  description: "Dive deep into advanced React patterns and learn how to build more efficient and scalable applications. This webinar covers HOCs, Render Props, Hooks, and more.",
  price: 49.99,
};

const WebinarPage: React.FC = () => {
  const handleBuyClick = () => {
    // Implement your buy logic here
    console.log("Buy button clicked");
  };

  return (
    <div className="min-h-screen bg-gray-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        <Card className="bg-white shadow-xl">
          <CardHeader>
            <CardTitle className="text-3xl font-bold text-gray-900">{webinarDetails.title}</CardTitle>
            <CardDescription className="text-xl text-gray-600">
              {webinarDetails.date} | {webinarDetails.time}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mt-4">
              <h3 className="text-lg font-medium text-gray-900">Speaker</h3>
              <p className="mt-1 text-gray-600">{webinarDetails.speaker}</p>
            </div>
            <div className="mt-6">
              <h3 className="text-lg font-medium text-gray-900">About This Webinar</h3>
              <p className="mt-1 text-gray-600">{webinarDetails.description}</p>
            </div>
            <div className="mt-6">
              <h3 className="text-lg font-medium text-gray-900">Price</h3>
              <p className="mt-1 text-2xl font-semibold text-gray-900">${webinarDetails.price.toFixed(2)}</p>
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={handleBuyClick} className="w-full">
              Register Now
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
};

export default WebinarPage;