import { faker } from "@faker-js/faker";
import { SupportPriority, SupportTicketStatus } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";

// Support ticket categories
const TICKET_CATEGORIES = [
  "Account",
  "Billing",
  "Technical",
  "Scheduling",
  "Other",
];

// Priority distribution: 10% URGENT, 20% HIGH, 50% MEDIUM, 20% LOW
const PRIORITY_WEIGHTS: { priority: SupportPriority; weight: number }[] = [
  { priority: "URGENT", weight: 10 },
  { priority: "HIGH", weight: 20 },
  { priority: "MEDIUM", weight: 50 },
  { priority: "LOW", weight: 20 },
];

// Status distribution: 30% OPEN, 25% IN_PROGRESS, 10% ON_HOLD, 25% RESOLVED, 10% CLOSED
const STATUS_WEIGHTS: { status: SupportTicketStatus; weight: number }[] = [
  { status: "OPEN", weight: 30 },
  { status: "IN_PROGRESS", weight: 25 },
  { status: "ON_HOLD", weight: 10 },
  { status: "RESOLVED", weight: 25 },
  { status: "CLOSED", weight: 10 },
];

// Ticket templates by category
const TICKET_TEMPLATES: Record<
  string,
  { titles: string[]; descriptions: string[] }
> = {
  Account: {
    titles: [
      "Cannot reset my password",
      "Need to update my email address",
      "Account locked after multiple login attempts",
      "Profile information not saving",
      "Cannot verify my email",
      "Need to deactivate my account",
      "Two-factor authentication issues",
      "Account was compromised",
    ],
    descriptions: [
      "I've been trying to reset my password for the past hour but I'm not receiving the reset email. I've checked spam and junk folders.",
      "I need to update my email address but the system says my new email is already in use. I don't have another account.",
      "My account got locked after I forgot my password and tried too many times. I need help unlocking it.",
      "When I try to save changes to my profile, I get an error message saying 'Something went wrong'. This has been happening for 2 days.",
      "I signed up yesterday but haven't received the email verification link. I've tried resending it multiple times.",
    ],
  },
  Billing: {
    titles: [
      "Charged twice for same subscription",
      "Refund not processed",
      "Invoice not received",
      "Payment method update failed",
      "Subscription not showing as active",
      "Need itemized receipt",
      "Promo code not applying",
      "Tax calculation seems incorrect",
    ],
    descriptions: [
      "I was charged twice for my monthly subscription on the same day. Please investigate and refund the duplicate charge.",
      "I requested a refund 2 weeks ago and it was approved, but the money still hasn't appeared in my account.",
      "I need an invoice for my company's records but I can't find where to download it from my account.",
      "I'm trying to update my credit card but the system keeps rejecting it. The card works fine everywhere else.",
      "I purchased a subscription plan but my account still shows as 'Free'. I have the payment confirmation email.",
    ],
  },
  Technical: {
    titles: [
      "Video call not connecting",
      "Cannot upload documents",
      "Mobile app keeps crashing",
      "Browser compatibility issue",
      "Integration not working",
      "Error when booking appointment",
      "Chat not loading",
      "Search not returning results",
    ],
    descriptions: [
      "I've tried to join my scheduled consultation 3 times but the video call just shows 'Connecting...' indefinitely.",
      "When I try to upload a PDF document for my consultation, I get an error saying 'Upload failed'. The file is only 2MB.",
      "The iOS app crashes every time I try to open my messages. I've tried reinstalling but the issue persists.",
      "The website doesn't work properly on Firefox. Some buttons are unresponsive and the layout looks broken.",
      "I connected my Google Calendar but new appointments aren't syncing. The connection shows as active in settings.",
    ],
  },
  Scheduling: {
    titles: [
      "Need to reschedule appointment",
      "Consultant not available at shown times",
      "Time zone confusion with booking",
      "Double booked accidentally",
      "Cannot cancel appointment",
      "Recurring appointment setup help",
      "Availability not showing correctly",
      "Booking confirmation not received",
    ],
    descriptions: [
      "I need to reschedule my appointment for tomorrow but the reschedule option is grayed out. The policy says I can reschedule up to 24 hours before.",
      "The calendar shows my consultant is available on Friday at 2 PM but when I try to book, it says 'Slot unavailable'.",
      "I'm in IST timezone but appointments are showing in a different timezone. I want to make sure I book at the correct time.",
      "I accidentally booked the same consultant twice for the same time slot. Please help me cancel one of them.",
      "The cancel button doesn't work for my upcoming appointment. I click it but nothing happens.",
    ],
  },
  Other: {
    titles: [
      "General inquiry about services",
      "Partnership opportunity",
      "Feedback on recent experience",
      "Request for feature",
      "Privacy concerns",
      "Consultant verification question",
      "Platform usage help",
      "Testimonial submission",
    ],
    descriptions: [
      "I'm interested in learning more about your consultation services before signing up. Can someone provide more information?",
      "I represent a company interested in partnering with your platform. Who should I contact to discuss this?",
      "I wanted to share some feedback about my recent experience with a consultant. It was excellent and I'd like to leave a testimonial.",
      "Is there a way to suggest new features? I have some ideas that might improve the platform.",
      "I have questions about how my personal data is used and stored. Can you provide details about your privacy practices?",
    ],
  },
};

// Response templates for different scenarios
const STAFF_RESPONSES = {
  initial: [
    "Thank you for reaching out to us. I'm looking into this issue for you and will get back to you shortly.",
    "Hi there! I've received your ticket and am reviewing the details. I'll have an update for you soon.",
    "Thank you for contacting support. I understand this is frustrating and I'm here to help resolve this.",
    "I appreciate you bringing this to our attention. Let me investigate and get back to you with a solution.",
  ],
  followUp: [
    "I wanted to follow up on this. Have you tried the steps I mentioned in my previous message?",
    "Just checking in - were you able to resolve the issue with the solution provided?",
    "I haven't heard back from you. Please let me know if you need any additional assistance.",
    "Following up on your ticket. Is there anything else I can help you with?",
  ],
  resolution: [
    "I'm happy to report that this issue has been resolved. Please let us know if you experience any further problems.",
    "The fix has been implemented. You should now be able to proceed without issues.",
    "I've made the necessary changes to your account. Everything should be working correctly now.",
    "This has been escalated and resolved by our technical team. Thank you for your patience.",
  ],
  userFollowUp: [
    "Thank you for the quick response! I'll try that and let you know.",
    "I tried the suggested solution but I'm still experiencing the same issue.",
    "That worked! Thank you so much for your help.",
    "I have an additional question related to this issue.",
    "The problem seems to be intermittent. Sometimes it works, sometimes it doesn't.",
  ],
};

function getWeightedPriority(): SupportPriority {
  const totalWeight = PRIORITY_WEIGHTS.reduce(
    (sum, item) => sum + item.weight,
    0,
  );
  let random = faker.number.int({ min: 1, max: totalWeight });

  for (const item of PRIORITY_WEIGHTS) {
    random -= item.weight;
    if (random <= 0) {
      return item.priority;
    }
  }
  return "MEDIUM";
}

function getWeightedStatus(): SupportTicketStatus {
  const totalWeight = STATUS_WEIGHTS.reduce(
    (sum, item) => sum + item.weight,
    0,
  );
  let random = faker.number.int({ min: 1, max: totalWeight });

  for (const item of STATUS_WEIGHTS) {
    random -= item.weight;
    if (random <= 0) {
      return item.status;
    }
  }
  return "OPEN";
}

import { config } from "./config";

// Support ticket volume - configurable via SEED_MODE environment variable
const NUM_TICKETS = config.volumes.supportTickets;

export async function createSupportTickets(
  users: UserWithProfiles[],
): Promise<void> {
  console.log(`Creating ${NUM_TICKETS} support tickets with responses...`);

  // Get users by role
  const consultees = users.filter((user) => user.role === "CONSULTEE");
  const consultants = users.filter((user) => user.role === "CONSULTANT");
  const staffAndAdmins = users.filter(
    (user) => user.role === "STAFF" || user.role === "ADMIN",
  );

  const ticketCreators = [...consultees, ...consultants];

  if (ticketCreators.length === 0) {
    console.warn("No eligible users found for support ticket creation");
    return;
  }

  if (staffAndAdmins.length === 0) {
    console.warn("No staff/admin users found for support responses");
    return;
  }

  let ticketsCreated = 0;
  let responsesCreated = 0;

  for (let i = 0; i < NUM_TICKETS; i++) {
    try {
      const creator = faker.helpers.arrayElement(ticketCreators);
      const category = faker.helpers.arrayElement(TICKET_CATEGORIES);
      const templates = TICKET_TEMPLATES[category];
      const title = faker.helpers.arrayElement(templates.titles);
      const description = faker.helpers.arrayElement(templates.descriptions);
      const priority = getWeightedPriority();
      const status = getWeightedStatus();

      const ticketDate = faker.date.recent({ days: 30 });

      const ticket = await prisma.supportTicket.create({
        data: {
          title,
          description,
          priority,
          status,
          category,
          userId: creator.id,
          createdAt: ticketDate,
        },
      });

      ticketsCreated++;

      // Create responses based on status
      const numResponses =
        status === "OPEN"
          ? faker.number.int({ min: 0, max: 2 })
          : faker.number.int({ min: 1, max: 5 });

      let lastResponseDate = new Date(ticketDate);

      for (let j = 0; j < numResponses; j++) {
        // Alternate between staff and user responses
        const isStaffResponse = j % 2 === 0;
        const responder = isStaffResponse
          ? faker.helpers.arrayElement(staffAndAdmins)
          : creator;

        let message: string;
        if (isStaffResponse) {
          if (j === 0) {
            message = faker.helpers.arrayElement(STAFF_RESPONSES.initial);
          } else if (status === "RESOLVED" || status === "CLOSED") {
            message = faker.helpers.arrayElement(STAFF_RESPONSES.resolution);
          } else {
            message = faker.helpers.arrayElement(STAFF_RESPONSES.followUp);
          }
        } else {
          message = faker.helpers.arrayElement(STAFF_RESPONSES.userFollowUp);
        }

        // Response date is after ticket creation and previous response
        lastResponseDate = faker.date.between({
          from: lastResponseDate,
          to: new Date(),
        });

        await prisma.supportResponse.create({
          data: {
            message,
            supportTicketId: ticket.id,
            userId: responder.id,
            createdAt: lastResponseDate,
          },
        });

        responsesCreated++;
      }

      if (ticketsCreated % 10 === 0) {
        console.log(
          `Created ${ticketsCreated} tickets, ${responsesCreated} responses...`,
        );
      }
    } catch (error) {
      console.error(`Failed to create support ticket ${i + 1}:`, error);
    }
  }

  console.log(
    `Created ${ticketsCreated} support tickets with ${responsesCreated} responses`,
  );
}
