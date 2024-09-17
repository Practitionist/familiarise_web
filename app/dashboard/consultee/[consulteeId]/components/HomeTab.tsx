"use client"

import React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { ArrowLeftIcon, ArrowRightIcon } from "@/assets/icons"
import { motion } from "framer-motion"
import { Badge } from "@/components/ui/badge"

export default function HomeTab() {
  return (
    <div className="space-y-6 min-h-[calc(100vh-200px)]">
      <h2 className="text-3xl font-bold">Home</h2>
      <div className="grid grid-cols-2 gap-8">
        <div>
          <Card className="w-full mb-6 rounded-lg shadow-lg bg-white">
            <CardHeader>
              <div className="flex items-center space-x-4">
                <Avatar className="rounded-full">
                  <AvatarImage src="/placeholder.svg" alt="Consultant avatar" />
                  <AvatarFallback>C</AvatarFallback>
                </Avatar>
                <div>
                  <CardTitle className="text-xl font-semibold">Consulting Session</CardTitle>
                  <div className="flex items-center space-x-2 text-gray-500 text-sm">
                    <p>11 Nov - 16 Nov</p>
                    <span>•</span>
                    <p>11:00 AM</p>
                  </div>
                  <div className="mt-2 text-sm text-gray-500">
                    <p>Consultant: John Doe</p>
                    <p>Consultation Details: 1-on-1 session to discuss your business goals and strategy</p>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex justify-end mt-4">
                <Button
                  variant="outline"
                  className="rounded-md px-4 py-2 transition-colors hover:bg-gray-200 bg-black text-white"
                >
                  Join
                </Button>
              </div>
            </CardContent>
          </Card>
          <div>
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-xl font-semibold">Upcoming Schedule</h2>
              <div className="flex items-center space-x-2">
                <ArrowLeftIcon className="h-4 w-4 text-gray-500 hover:text-gray-700 cursor-pointer" />
                <p className="text-sm text-gray-500">December 2023</p>
                <ArrowRightIcon className="h-4 w-4 text-gray-500 hover:text-gray-700 cursor-pointer" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <DashboardCard
                title="Design Consultation"
                items={[
                  { title: "With Sarah Johnson", date: "Dec 10, 2023 - 2:00 PM" },
                ]}
              />
              <DashboardCard
                title="Marketing Strategy"
                items={[
                  { title: "With Mike Brown", date: "Dec 15, 2023 - 3:00 PM" },
                ]}
              />
              <DashboardCard
                title="Financial Planning"
                items={[
                  { title: "With Emily Davis", date: "Dec 20, 2023 - 10:00 AM" },
                ]}
              />
              <DashboardCard
                title="Product Development"
                items={[
                  { title: "With Alex Turner", date: "Dec 22, 2023 - 1:00 PM" },
                ]}
              />
            </div>
          </div>
        </div>
        <div>
          <Card className="w-full mb-6 rounded-lg shadow-lg bg-white">
            <CardHeader>
              <CardTitle className="text-xl font-semibold">Upcoming Events</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4">
                <DashboardCard
                  title="Webinar: Startup Funding"
                  items={[
                    { title: "Speaker: John Smith", date: "Dec 5, 2023 - 2:00 PM", status: "Registered" },
                  ]}
                />
                <DashboardCard
                  title="Workshop: Digital Marketing"
                  items={[
                    { title: "Instructor: Lisa Wong", date: "Dec 12, 2023 - 10:00 AM", status: "Not Registered" },
                  ]}
                />
                <DashboardCard
                  title="Conference: Tech Innovations"
                  items={[
                    { title: "Various Speakers", date: "Dec 18-20, 2023", status: "Registered" },
                  ]}
                />
                <DashboardCard
                  title="Networking: Entrepreneurs Meetup"
                  items={[
                    { title: "Host: Startup Hub", date: "Dec 25, 2023 - 6:00 PM", status: "Not Registered" },
                  ]}
                />
              </div>
              <div className="mt-4 text-right">
                <Button
                  variant="outline"
                  className="rounded-md px-4 py-2 transition-colors hover:bg-gray-200 text-gray-500"
                >
                  View All
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function DashboardCard({ title, items }: { title: string; items: { title: string; date: string; status?: string }[] }) {
  return (
    <Card className="bg-white">
      <CardHeader>
        <CardTitle className="text-lg font-semibold bg-white">{title}</CardTitle>
      </CardHeader>
      <CardContent className="bg-white">
        <div className="space-y-4">
          {items.map((item, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className="flex items-center justify-between bg-white"
            >
              <div>
                <div className="font-medium bg-white" >{item.title}</div>
                <div className="text-sm text-muted-foreground bg-white">{item.date}</div>
              </div>
              {item.status && (
                <Badge variant={item.status.includes("Not") ? "secondary" : "default"} className="bg-white">
                  {item.status}
                </Badge>
              )}
            </motion.div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}