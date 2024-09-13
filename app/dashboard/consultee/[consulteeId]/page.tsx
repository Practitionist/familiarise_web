"use client"

import { useState } from "react"
import Link from "next/link"
import { motion } from "framer-motion"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default function ConsulteeDashboard() {
  return (
    <div className="bg-gradient-to-b from-background to-muted min-h-screen pt-32 pb-16">
      <div className="container mx-auto px-4 space-y-8">
        <Header />
        <Tabs defaultValue="overview" className="space-y-8">
          <TabsList className="grid w-full grid-cols-3 lg:w-[400px] rounded-lg overflow-hidden">
            <TabsTrigger value="overview" className="data-[state=active]:bg-black data-[state=active]:text-white border-t border-l border-b rounded-tl-lg rounded-bl-lg">Overview</TabsTrigger>
            <TabsTrigger value="upcoming" className="data-[state=active]:bg-black data-[state=active]:text-white border-t border-b">Upcoming</TabsTrigger>
            <TabsTrigger value="calendar" className="data-[state=active]:bg-black data-[state=active]:text-white border-t border-r border-b rounded-tr-lg rounded-br-lg">Calendar</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="space-y-8 rounded-lg">
            <Overview />
          </TabsContent>
          <TabsContent value="upcoming" className="space-y-8 rounded-lg">
            <Upcoming />
          </TabsContent>
          <TabsContent value="calendar" className="space-y-8 rounded-lg">
            <Calendar />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

function Header() {
  return (
    <div className="flex flex-col sm:flex-row justify-between items-center space-y-4 sm:space-y-0">
      <h1 className="text-3xl font-bold">Consultee Dashboard</h1>
    </div>
  )
}

function Overview() {
  return (
    <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
      <DashboardCard
        title="Upcoming Consultations"
        items={[
          { title: "Design Consultation", date: "June 15, 2023 - 2:00 PM" },
          { title: "Marketing Consultation", date: "June 22, 2023 - 4:00 PM" },
        ]}
      />
      <DashboardCard
        title="Active Subscriptions"
        items={[
          { title: "Monthly Coaching", date: "Expires: July 31, 2023" },
          { title: "Quarterly Strategy", date: "Expires: Sep 30, 2023" },
        ]}
      />
      <DashboardCard
        title="Upcoming Classes"
        items={[
          { title: "Design Fundamentals", date: "June 20-24, 2023", status: "Enrolled" },
          { title: "Marketing Strategies", date: "July 10-14, 2023", status: "Not Enrolled" },
        ]}
      />
      <DashboardCard
        title="Upcoming Webinars"
        items={[
          { title: "Branding Masterclass", date: "June 30, 2023 - 2:00 PM", status: "Registered" },
          { title: "Social Media Strategies", date: "July 15, 2023 - 4:00 PM", status: "Not Registered" },
        ]}
      />
    </div>
  )
}

function Upcoming() {
  return (
    <div className="space-y-8">
      <Section title="Consultations">
        <ConsultationCard
          title="Design Consultation"
          consultant="John Doe"
          date="June 15, 2023 - 2:00 PM"
          buttonText="Join"
        />
        <ConsultationCard
          title="Marketing Consultation"
          consultant="Jane Smith"
          date="June 22, 2023 - 4:00 PM"
          buttonText="Join"
        />
      </Section>
      <Section title="Subscriptions">
        <ConsultationCard
          title="Monthly Coaching"
          consultant="Alice Johnson"
          date="Expires: July 31, 2023"
          buttonText="Renew"
        />
        <ConsultationCard
          title="Quarterly Strategy"
          consultant="Bob Williams"
          date="Expires: Sep 30, 2023"
          buttonText="Renew"
        />
      </Section>
      <Section title="Classes">
        <ConsultationCard
          title="Design Fundamentals"
          consultant="Alice Johnson"
          date="June 20, 2023 - June 24, 2023"
          buttonText="View Details"
        />
        <ConsultationCard
          title="Marketing Strategies"
          consultant="Bob Williams"
          date="July 10, 2023 - July 14, 2023"
          buttonText="Enroll"
        />
      </Section>
      <Section title="Webinars">
        <ConsultationCard
          title="Branding Masterclass"
          consultant="Emma Brown"
          date="June 30, 2023 - 2:00 PM"
          buttonText="Join"
        />
        <ConsultationCard
          title="Social Media Strategies"
          consultant="David Lee"
          date="July 15, 2023 - 4:00 PM"
          buttonText="Register"
        />
      </Section>
    </div>
  )
}

function Calendar() {
  return (
    <div className="bg-card text-card-foreground rounded-lg p-6">
      <h2 className="text-2xl font-semibold mb-4">Calendar View</h2>
      <p className="text-muted-foreground">Calendar integration coming soon...</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-2xl font-semibold mb-4">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {children}
      </div>
    </section>
  )
}

function DashboardCard({ title, items }: { title: string; items: { title: string; date: string; status?: string }[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {items.map((item, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className="flex items-center justify-between"
            >
              <div>
                <div className="font-medium">{item.title}</div>
                <div className="text-sm text-muted-foreground">{item.date}</div>
              </div>
              {item.status && (
                <Badge variant={item.status.includes("Not") ? "secondary" : "default"}>
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

function ConsultationCard({ title, consultant, date, buttonText }: { title: string; consultant: string; date: string; buttonText: string }) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center space-x-4 mb-4">
          <Avatar>
            <AvatarFallback>{consultant.split(' ').map(n => n[0]).join('')}</AvatarFallback>
          </Avatar>
          <div>
            <h3 className="font-semibold">{title}</h3>
            <p className="text-sm text-muted-foreground">{consultant}</p>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">{date}</div>
          <Button size="sm">{buttonText}</Button>
        </div>
      </CardContent>
    </Card>
  )
}
