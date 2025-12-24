"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Search,
  HelpCircle,
  MessageCircle,
  Phone,
  Mail,
  Clock,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Send,
  BookOpen,
  Video,
  Users,
} from "lucide-react";

// Mock data
const quickHelp = [
  {
    title: "Getting Started Guide",
    description: "Learn the basics of the staff portal",
    icon: BookOpen,
    color: "text-blue-600 bg-blue-50 dark:bg-blue-950",
  },
  {
    title: "Video Tutorials",
    description: "Watch step-by-step guides",
    icon: Video,
    color: "text-purple-600 bg-purple-50 dark:bg-purple-950",
  },
  {
    title: "Team Directory",
    description: "Find colleagues and escalation contacts",
    icon: Users,
    color: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950",
  },
  {
    title: "Live Chat Support",
    description: "Chat with IT support team",
    icon: MessageCircle,
    color: "text-amber-600 bg-amber-50 dark:bg-amber-950",
  },
];

const faqs = [
  {
    question: "How do I reset my password?",
    answer:
      "Go to Settings > Security > Change Password. If you're locked out, contact IT support through the help desk or email it-support@familiarise.com.",
  },
  {
    question: "Where can I find my shift schedule?",
    answer:
      "Your shift schedule is available in Settings > Work Schedule. You can also check the team calendar in the Chat section for team-wide schedules.",
  },
  {
    question: "How do I request time off?",
    answer:
      "Submit time-off requests through HR Portal (linked in Settings). For urgent requests, email your supervisor directly and CC hr@familiarise.com.",
  },
  {
    question: "Who do I contact for technical issues?",
    answer:
      "For platform technical issues, create a ticket in the IT Help Desk. For urgent issues affecting users, escalate through the #tech-support channel in Team Chat.",
  },
  {
    question: "How do I access previous training materials?",
    answer:
      "All training materials are available in the Knowledge Base under 'Getting Started' and 'Video Tutorials' categories. Contact HR for access to advanced training modules.",
  },
];

const supportContacts = [
  {
    name: "IT Support",
    availability: "24/7",
    email: "it-support@familiarise.com",
    phone: "+91 1800-XXX-XXXX",
  },
  {
    name: "HR Department",
    availability: "Mon-Fri 9AM-6PM",
    email: "hr@familiarise.com",
    phone: "+91 1800-XXX-XXXY",
  },
  {
    name: "Admin Escalation",
    availability: "24/7 for urgent issues",
    email: "admin-escalation@familiarise.com",
    phone: "+91 1800-XXX-XXXZ",
  },
];

export default function HelpPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [ticketSubject, setTicketSubject] = useState("");
  const [ticketDescription, setTicketDescription] = useState("");
  const [ticketCategory, setTicketCategory] = useState("");

  const handleSubmitTicket = () => {
    // Handle ticket submission
    alert("Support ticket submitted successfully!");
    setTicketSubject("");
    setTicketDescription("");
    setTicketCategory("");
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          Help & Support
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400 mt-2">
          Get help with the staff portal, find answers, or contact support
        </p>
        <div className="relative mt-6">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-400" />
          <Input
            placeholder="Search for help..."
            className="pl-12 h-12 text-base"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Quick Help Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {quickHelp.map((item) => (
          <Card
            key={item.title}
            className="cursor-pointer hover:shadow-md transition-shadow"
          >
            <CardContent className="p-4">
              <div className={`p-3 rounded-lg w-fit ${item.color}`}>
                <item.icon className="h-6 w-6" />
              </div>
              <h3 className="font-medium mt-3">{item.title}</h3>
              <p className="text-sm text-zinc-500 mt-1">{item.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* FAQs */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HelpCircle className="h-5 w-5" />
              Frequently Asked Questions
            </CardTitle>
            <CardDescription>
              Common questions about the staff portal
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion type="single" collapsible className="w-full">
              {faqs.map((faq, index) => (
                <AccordionItem key={index} value={`item-${index}`}>
                  <AccordionTrigger className="text-left">
                    {faq.question}
                  </AccordionTrigger>
                  <AccordionContent className="text-zinc-600 dark:text-zinc-400">
                    {faq.answer}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </CardContent>
        </Card>

        {/* Contact Information */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Phone className="h-5 w-5" />
              Contact Support
            </CardTitle>
            <CardDescription>Reach out for assistance</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {supportContacts.map((contact) => (
                <div
                  key={contact.name}
                  className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800"
                >
                  <h4 className="font-medium">{contact.name}</h4>
                  <div className="mt-2 space-y-1 text-sm">
                    <div className="flex items-center gap-2 text-zinc-500">
                      <Clock className="h-3 w-3" />
                      {contact.availability}
                    </div>
                    <div className="flex items-center gap-2 text-zinc-500">
                      <Mail className="h-3 w-3" />
                      <a
                        href={`mailto:${contact.email}`}
                        className="hover:text-blue-600"
                      >
                        {contact.email}
                      </a>
                    </div>
                    <div className="flex items-center gap-2 text-zinc-500">
                      <Phone className="h-3 w-3" />
                      {contact.phone}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Submit Support Ticket */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5" />
            Submit a Support Ticket
          </CardTitle>
          <CardDescription>
            Can&apos;t find what you&apos;re looking for? Submit a ticket to the
            support team
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Select value={ticketCategory} onValueChange={setTicketCategory}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="technical">Technical Issue</SelectItem>
                  <SelectItem value="access">Access / Permissions</SelectItem>
                  <SelectItem value="training">Training Request</SelectItem>
                  <SelectItem value="feedback">
                    Feedback / Suggestion
                  </SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="subject">Subject</Label>
              <Input
                id="subject"
                placeholder="Brief description of your issue"
                value={ticketSubject}
                onChange={(e) => setTicketSubject(e.target.value)}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Provide detailed information about your issue or request..."
                rows={4}
                value={ticketDescription}
                onChange={(e) => setTicketDescription(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end mt-4">
            <Button
              onClick={handleSubmitTicket}
              disabled={!ticketCategory || !ticketSubject || !ticketDescription}
              className="gap-2"
            >
              <Send className="h-4 w-4" />
              Submit Ticket
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* System Status */}
      <Card>
        <CardHeader>
          <CardTitle>System Status</CardTitle>
          <CardDescription>Current platform status</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { name: "Staff Portal", status: "operational" },
              { name: "Video Calling", status: "operational" },
              { name: "Payment Gateway", status: "operational" },
              { name: "Email Services", status: "degraded" },
            ].map((service) => (
              <div
                key={service.name}
                className="flex items-center justify-between p-3 rounded-lg border border-zinc-200 dark:border-zinc-800"
              >
                <span className="text-sm font-medium">{service.name}</span>
                {service.status === "operational" ? (
                  <Badge className="bg-green-100 text-green-700 gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    Operational
                  </Badge>
                ) : (
                  <Badge className="bg-amber-100 text-amber-700 gap-1">
                    <AlertCircle className="h-3 w-3" />
                    Degraded
                  </Badge>
                )}
              </div>
            ))}
          </div>
          <div className="mt-4 text-center">
            <Button variant="link" className="gap-1">
              View full status page
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
