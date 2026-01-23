"use client";

import { useState, useEffect } from "react";
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
  Loader2,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Quick help items (static)
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

interface FAQ {
  id: string;
  question: string;
  answer: string;
  category: string;
  order: number;
}

interface SupportContact {
  id: string;
  name: string;
  department: string;
  email: string;
  phone: string | null;
  availability: string;
}

interface SystemStatus {
  id: string;
  serviceName: string;
  status: "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE";
  description: string | null;
  lastCheckedAt: string;
}

export default function HelpPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [ticketSubject, setTicketSubject] = useState("");
  const [ticketDescription, setTicketDescription] = useState("");
  const [ticketCategory, setTicketCategory] = useState("");
  const [submittingTicket, setSubmittingTicket] = useState(false);

  // Data states
  const [faqs, setFaqs] = useState<FAQ[]>([]);
  const [contacts, setContacts] = useState<SupportContact[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus[]>([]);

  // Loading states
  const [loadingFaqs, setLoadingFaqs] = useState(true);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(true);

  const { toast } = useToast();

  // Fetch FAQs
  const fetchFaqs = async () => {
    try {
      setLoadingFaqs(true);
      const response = await fetch("/api/staff/help/faqs");
      if (!response.ok) throw new Error("Failed to fetch FAQs");
      const data = await response.json();
      setFaqs(data.faqs || []);
    } catch (error) {
      console.error("Error fetching FAQs:", error);
      toast({
        title: "Error",
        description: "Failed to load FAQs",
        variant: "destructive",
      });
    } finally {
      setLoadingFaqs(false);
    }
  };

  // Fetch support contacts
  const fetchContacts = async () => {
    try {
      setLoadingContacts(true);
      const response = await fetch("/api/staff/help/contacts");
      if (!response.ok) throw new Error("Failed to fetch contacts");
      const data = await response.json();
      setContacts(data.contacts || []);
    } catch (error) {
      console.error("Error fetching contacts:", error);
      toast({
        title: "Error",
        description: "Failed to load support contacts",
        variant: "destructive",
      });
    } finally {
      setLoadingContacts(false);
    }
  };

  // Fetch system status
  const fetchSystemStatus = async () => {
    try {
      setLoadingStatus(true);
      const response = await fetch("/api/staff/help/status");
      if (!response.ok) throw new Error("Failed to fetch system status");
      const data = await response.json();
      setSystemStatus(data.services || []);
    } catch (error) {
      console.error("Error fetching system status:", error);
      toast({
        title: "Error",
        description: "Failed to load system status",
        variant: "destructive",
      });
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    fetchFaqs();
    fetchContacts();
    fetchSystemStatus();
  }, []);

  const handleSubmitTicket = async () => {
    if (!ticketCategory || !ticketSubject || !ticketDescription) return;

    setSubmittingTicket(true);
    try {
      // Submit ticket to the support tickets API
      const response = await fetch("/api/staff/support-tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: ticketSubject,
          description: ticketDescription,
          category: ticketCategory.toUpperCase(),
          priority: "MEDIUM",
        }),
      });

      if (!response.ok) throw new Error("Failed to submit ticket");

      toast({
        title: "Ticket Submitted",
        description: "Your support ticket has been submitted successfully.",
      });

      setTicketSubject("");
      setTicketDescription("");
      setTicketCategory("");
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to submit support ticket",
        variant: "destructive",
      });
    } finally {
      setSubmittingTicket(false);
    }
  };

  // Filter FAQs by search query
  const filteredFaqs = searchQuery
    ? faqs.filter(
        (faq) =>
          faq.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
          faq.answer.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : faqs;

  const getStatusBadge = (status: SystemStatus["status"]) => {
    switch (status) {
      case "OPERATIONAL":
        return (
          <Badge className="bg-green-100 text-green-700 gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Operational
          </Badge>
        );
      case "DEGRADED":
        return (
          <Badge className="bg-amber-100 text-amber-700 gap-1">
            <AlertCircle className="h-3 w-3" />
            Degraded
          </Badge>
        );
      case "OUTAGE":
        return (
          <Badge className="bg-red-100 text-red-700 gap-1">
            <AlertTriangle className="h-3 w-3" />
            Outage
          </Badge>
        );
      case "MAINTENANCE":
        return (
          <Badge className="bg-blue-100 text-blue-700 gap-1">
            <Clock className="h-3 w-3" />
            Maintenance
          </Badge>
        );
    }
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
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <HelpCircle className="h-5 w-5" />
                  Frequently Asked Questions
                </CardTitle>
                <CardDescription>
                  Common questions about the staff portal
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchFaqs}
                disabled={loadingFaqs}
              >
                <RefreshCw
                  className={`h-4 w-4 ${loadingFaqs ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loadingFaqs ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
              </div>
            ) : filteredFaqs.length === 0 ? (
              <p className="text-center text-zinc-500 py-8">
                {searchQuery ? "No FAQs match your search" : "No FAQs available"}
              </p>
            ) : (
              <Accordion type="single" collapsible className="w-full">
                {filteredFaqs.map((faq) => (
                  <AccordionItem key={faq.id} value={faq.id}>
                    <AccordionTrigger className="text-left">
                      {faq.question}
                    </AccordionTrigger>
                    <AccordionContent className="text-zinc-600 dark:text-zinc-400">
                      {faq.answer}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            )}
          </CardContent>
        </Card>

        {/* Contact Information */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Phone className="h-5 w-5" />
                  Contact Support
                </CardTitle>
                <CardDescription>Reach out for assistance</CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchContacts}
                disabled={loadingContacts}
              >
                <RefreshCw
                  className={`h-4 w-4 ${loadingContacts ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loadingContacts ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
              </div>
            ) : contacts.length === 0 ? (
              <p className="text-center text-zinc-500 py-8">
                No contacts available
              </p>
            ) : (
              <div className="space-y-4">
                {contacts.map((contact) => (
                  <div
                    key={contact.id}
                    className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800"
                  >
                    <h4 className="font-medium">{contact.name}</h4>
                    <p className="text-xs text-zinc-400">{contact.department}</p>
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
                      {contact.phone && (
                        <div className="flex items-center gap-2 text-zinc-500">
                          <Phone className="h-3 w-3" />
                          {contact.phone}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
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
              disabled={
                !ticketCategory ||
                !ticketSubject ||
                !ticketDescription ||
                submittingTicket
              }
              className="gap-2"
            >
              {submittingTicket ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Submit Ticket
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* System Status */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>System Status</CardTitle>
              <CardDescription>Current platform status</CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchSystemStatus}
              disabled={loadingStatus}
            >
              <RefreshCw
                className={`h-4 w-4 ${loadingStatus ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loadingStatus ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
            </div>
          ) : systemStatus.length === 0 ? (
            <p className="text-center text-zinc-500 py-8">
              No system status information available
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {systemStatus.map((service) => (
                <div
                  key={service.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-zinc-200 dark:border-zinc-800"
                >
                  <span className="text-sm font-medium">
                    {service.serviceName}
                  </span>
                  {getStatusBadge(service.status)}
                </div>
              ))}
            </div>
          )}
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
