/// <reference types="cypress" />

import {
  Consultation as PrismaConsultation,
  Subscription as PrismaSubscription,
  Webinar as PrismaWebinar,
  Class as PrismaClass,
  SlotOfAppointment as PrismaSlot,
  ConsultationPlan as PrismaConsultationPlan,
  SubscriptionPlan as PrismaSubscriptionPlan,
  WebinarPlan as PrismaWebinarPlan,
  ClassPlan as PrismaClassPlan,
  User as PrismaUser,
  ConsultantProfile as PrismaConsultantProfile,
} from "@prisma/client"; // Adjust path if your prisma client is located elsewhere

import { setupConsultantAppointments } from "./consultant-setup.cy";

// --- Define more specific types for API responses (Prisma types with includes) ---
type ApiConsultation = PrismaConsultation & {
  slotsOfConsultation?: PrismaSlot[];
  consultationPlan: PrismaConsultationPlan & {
    consultantProfile?: PrismaConsultantProfile & { user?: PrismaUser };
  };
};

type ApiSubscription = PrismaSubscription & {
  slotsOfSubscription?: PrismaSlot[];
  subscriptionPlan: PrismaSubscriptionPlan & {
    consultantProfile?: PrismaConsultantProfile & { user?: PrismaUser };
  };
};

type ApiWebinar = PrismaWebinar & {
  slotsOfWebinar?: PrismaSlot[];
  webinarPlan: PrismaWebinarPlan;
};

type ApiClass = PrismaClass & {
  slotsOfClass?: PrismaSlot[];
  classPlan: PrismaClassPlan;
};

// --- Define the type for the processed slots returned by getAllSlots ---
type ProcessedSlot = PrismaSlot & {
  appointmentType: "Consultation" | "Subscription" | "Webinar" | "Class";
  eventDetails: ApiConsultation | ApiSubscription | ApiWebinar | ApiClass;
};

// Helper function to process slots from different event types
function getAllSlots(
  consultations: ApiConsultation[],
  subscriptions: ApiSubscription[],
  webinars: ApiWebinar[],
  classes: ApiClass[],
): ProcessedSlot[] {
  const allProcessedSlots: ProcessedSlot[] = [];

  // Process consultations
  consultations.forEach((consultation) => {
    if (consultation && consultation.slotsOfConsultation) {
      consultation.slotsOfConsultation?.forEach((slot: PrismaSlot) => {
        allProcessedSlots.push({
          ...slot,
          appointmentType: "Consultation",
          eventDetails: consultation,
        });
      });
    }
  });

  // Process subscriptions
  subscriptions.forEach((subscription) => {
    if (subscription && subscription.slotsOfSubscription) {
      subscription.slotsOfSubscription?.forEach((slot: PrismaSlot) => {
        allProcessedSlots.push({
          ...slot,
          appointmentType: "Subscription",
          eventDetails: subscription,
        });
      });
    }
  });

  // Process webinars
  webinars.forEach((webinar) => {
    if (webinar && webinar.slotsOfWebinar) {
      webinar.slotsOfWebinar?.forEach((slot: PrismaSlot) => {
        allProcessedSlots.push({
          ...slot,
          appointmentType: "Webinar",
          eventDetails: webinar,
        });
      });
    }
  });

  // Process classes
  classes.forEach((classItem) => {
    if (classItem && classItem.slotsOfClass) {
      classItem.slotsOfClass?.forEach((slot: PrismaSlot) => {
        allProcessedSlots.push({
          ...slot,
          appointmentType: "Class",
          eventDetails: classItem,
        });
      });
    }
  });

  return allProcessedSlots;
}

// Helper function to format date and time
function formatDateTime(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const dayName = days[date.getDay()];
  const monthName = months[date.getMonth()];
  const day = date.getDate();
  const hour = date.getHours() % 12 || 12;
  const minute = date.getMinutes().toString().padStart(2, "0");
  const period = date.getHours() < 12 ? "AM" : "PM";

  return `${dayName}, ${monthName} ${day}, ${hour}:${minute} ${period}`;
}

// Helper function to parse formatted date-time string back to Date object
function parseFormattedDateTime(dateTimeStr: string): Date {
  // Example: "Sun, Jul 21, 10:00 AM"
  const parts = dateTimeStr.split(", ");
  const monthDay = parts[1].split(" ");
  const timePeriod = parts[2].split(" ");
  const time = timePeriod[0].split(":");

  const currentYear = new Date().getFullYear();
  const monthIndex = new Date(Date.parse(monthDay[0] + " 1, 2000")).getMonth();
  let hours = parseInt(time[0]);
  const minutes = parseInt(time[1]);

  if (timePeriod[1] === "PM" && hours < 12) hours += 12;
  if (timePeriod[1] === "AM" && hours === 12) hours = 0;

  return new Date(
    currentYear,
    monthIndex,
    parseInt(monthDay[1]),
    hours,
    minutes,
  );
}

describe("Consultant Appointments Page with Dynamic ID", () => {
  let dynamicConsultantId: string;

  before(() => {
    // Assuming an endpoint /api/user/consultants exists and returns consultants with an 'id'
    cy.request<{ data: (PrismaConsultantProfile & { user?: PrismaUser })[] }>(
      "GET",
      "/api/user/consultants",
    )
      .its("body")
      .then(
        (responseBody: {
          data: (PrismaConsultantProfile & { user?: PrismaUser })[];
        }) => {
          // Check if responseBody.data exists and is an array
          if (
            responseBody &&
            responseBody.data &&
            Array.isArray(responseBody.data) &&
            responseBody.data.length > 0
          ) {
            const firstConsultant = responseBody.data[0];
            // Check if the first consultant has a user object and the user object has an id
            if (firstConsultant && firstConsultant.id) {
              // Check for consultant's own ID
              dynamicConsultantId = firstConsultant.id; // Use the consultant profile's ID
              cy.log(`Fetched Consultant Profile ID: ${dynamicConsultantId}`);
              // Setup intercepts using the fetched ID
              setupConsultantAppointments(dynamicConsultantId);
            } else {
              throw new Error(
                "Failed to fetch consultant profile ID: firstConsultant.id not found.",
              );
            }
          } else {
            throw new Error(
              "Failed to fetch consultant ID or no consultants found from API (response.data is empty or not an array).",
            );
          }
        },
      );
  });

  beforeEach(() => {
    if (!dynamicConsultantId) {
      throw new Error("Consultant ID was not available for beforeEach setup.");
    }
    // Call the setup function from consultant-setup.cy.ts
    setupConsultantAppointments(dynamicConsultantId);
  });

  it("verifies appointments from API match UI", () => {
    cy.wait([
      "@getConsultations",
      "@getSubscriptions",
      "@getWebinars",
      "@getClasses",
    ]).then((interceptions) => {
      expect(interceptions[0].response?.statusCode).to.equal(200);
      expect(interceptions[1].response?.statusCode).to.equal(200);
      expect(interceptions[2].response?.statusCode).to.equal(200);
      expect(interceptions[3].response?.statusCode).to.equal(200);

      const apiConsultations = (interceptions[0].response?.body?.data ||
        []) as ApiConsultation[];
      const apiSubscriptions = (interceptions[1].response?.body?.data ||
        []) as ApiSubscription[];
      const apiWebinars = (interceptions[2].response?.body?.data ||
        []) as ApiWebinar[];
      const apiClasses = (interceptions[3].response?.body?.data ||
        []) as ApiClass[];

      cy.log("API Consultations:", apiConsultations);
      cy.log("API Subscriptions:", apiSubscriptions);
      cy.log("API Webinars:", apiWebinars);
      cy.log("API Classes:", apiClasses);

      const allSlots = getAllSlots(
        apiConsultations,
        apiSubscriptions,
        apiWebinars,
        apiClasses,
      );
      cy.log("All Slots from UI perspective:", allSlots);

      const sortedSlots = allSlots.sort(
        (a: ProcessedSlot, b: ProcessedSlot) =>
          new Date(a.slotStartTimeInUTC).getTime() -
          new Date(b.slotStartTimeInUTC).getTime(),
      );

      if (sortedSlots.length === 0) {
        cy.contains("No Appointments Found").should("be.visible");
        return;
      }

      sortedSlots.forEach((slot: ProcessedSlot) => {
        const formattedTime = formatDateTime(new Date(slot.slotStartTimeInUTC));
        cy.log("Checking slot:", {
          time: formattedTime,
          eventDetails: slot.eventDetails,
        });

        cy.contains(formattedTime)
          .closest('[data-testid="appointment-item"]')
          .within(() => {
            if (slot.appointmentType === "Consultation") {
              cy.contains(
                `Consultation - ${(slot.eventDetails as ApiConsultation).consultationPlan.title}`,
              );
              cy.contains(
                (slot.eventDetails as ApiConsultation).consultationPlan
                  .consultantProfile?.user?.name || "",
              );
            } else if (slot.appointmentType === "Subscription") {
              cy.contains(
                `Subscription - ${(slot.eventDetails as ApiSubscription).subscriptionPlan.title}`,
              );
              cy.contains(
                (slot.eventDetails as ApiSubscription).subscriptionPlan
                  .consultantProfile?.user?.name || "",
              );
            } else if (slot.appointmentType === "Webinar") {
              cy.contains(
                `Webinar - ${(slot.eventDetails as ApiWebinar).webinarPlan.title}`,
              );
            } else if (slot.appointmentType === "Class") {
              cy.contains(
                `Class - ${(slot.eventDetails as ApiClass).classPlan.title}`,
              );
            }
            cy.contains(formattedTime);
          });
      });

      cy.get('[data-testid="appointment-item"]').should(
        "have.length",
        sortedSlots.length,
      );

      if (sortedSlots.length === 0) {
        cy.contains("No Appointments Found").should("be.visible");
      }
    });
  });

  it("verifies timezone conversion", () => {
    cy.wait([
      "@getConsultations",
      "@getSubscriptions",
      "@getWebinars",
      "@getClasses",
    ]).then((interceptions) => {
      expect(interceptions[0].response?.statusCode).to.equal(200);
      expect(interceptions[1].response?.statusCode).to.equal(200);
      expect(interceptions[2].response?.statusCode).to.equal(200);
      expect(interceptions[3].response?.statusCode).to.equal(200);

      const apiConsultations = (interceptions[0].response?.body?.data ||
        []) as ApiConsultation[];
      const apiSubscriptions = (interceptions[1].response?.body?.data ||
        []) as ApiSubscription[];
      const apiWebinars = (interceptions[2].response?.body?.data ||
        []) as ApiWebinar[];
      const apiClasses = (interceptions[3].response?.body?.data ||
        []) as ApiClass[];

      const allSlots = getAllSlots(
        apiConsultations,
        apiSubscriptions,
        apiWebinars,
        apiClasses,
      );

      if (allSlots.length === 0) {
        cy.log("No slots found, skipping timezone test.");
        return;
      }

      const sortedSlots = allSlots.sort(
        (a: ProcessedSlot, b: ProcessedSlot) =>
          new Date(a.slotStartTimeInUTC).getTime() -
          new Date(b.slotStartTimeInUTC).getTime(),
      );

      sortedSlots.forEach((slot: ProcessedSlot) => {
        const utcTime = new Date(slot.slotStartTimeInUTC);
        const localTime = formatDateTime(utcTime);
        cy.log("Checking timezone for slot:", {
          utcTime: slot.slotStartTimeInUTC,
          localTime,
          eventDetails: slot.eventDetails,
        });
        cy.contains(localTime)
          .closest('[data-testid="appointment-item"]')
          .should("be.visible");
      });
    });
  });

  it("verifies appointments are sorted correctly by time", () => {
    cy.wait([
      "@getConsultations",
      "@getSubscriptions",
      "@getWebinars",
      "@getClasses",
    ]).then((interceptions) => {
      expect(interceptions[0].response?.statusCode).to.equal(200);
      expect(interceptions[1].response?.statusCode).to.equal(200);
      expect(interceptions[2].response?.statusCode).to.equal(200);
      expect(interceptions[3].response?.statusCode).to.equal(200);

      const apiConsultations = (interceptions[0].response?.body?.data ||
        []) as ApiConsultation[];
      const apiSubscriptions = (interceptions[1].response?.body?.data ||
        []) as ApiSubscription[];
      const apiWebinars = (interceptions[2].response?.body?.data ||
        []) as ApiWebinar[];
      const apiClasses = (interceptions[3].response?.body?.data ||
        []) as ApiClass[];

      const allSlots = getAllSlots(
        apiConsultations,
        apiSubscriptions,
        apiWebinars,
        apiClasses,
      );

      if (allSlots.length === 0) {
        cy.log("No slots found, skipping sort test.");
        return;
      }

      const displayedTimes: string[] = [];
      // Assuming appointment items are rendered and time is in a specific element
      // This requires a class like '.appointment-time-class' on the time display element
      // If not present, this part of the test might fail or need adjustment.
      cy.get('[data-testid="appointment-item"] .appointment-time-class')
        .each(($el) => {
          displayedTimes.push($el.text());
        })
        .then(() => {
          cy.log("Displayed Times:", displayedTimes);
          if (displayedTimes.length > 0) {
            // Proceed only if times were found
            const displayedDateObjects = displayedTimes.map((timeStr) =>
              parseFormattedDateTime(timeStr),
            );
            for (let i = 0; i < displayedDateObjects.length - 1; i++) {
              expect(displayedDateObjects[i].getTime()).to.be.at.most(
                displayedDateObjects[i + 1].getTime(),
              );
            }
          }
        });
    });
  });

  it("navigates to the correct appointment details page on click", () => {
    cy.wait([
      "@getConsultations",
      "@getSubscriptions",
      "@getWebinars",
      "@getClasses",
    ]).then((interceptions) => {
      expect(interceptions[0].response?.statusCode).to.equal(200);
      expect(interceptions[1].response?.statusCode).to.equal(200);
      expect(interceptions[2].response?.statusCode).to.equal(200);
      expect(interceptions[3].response?.statusCode).to.equal(200);

      const apiConsultations = (interceptions[0].response?.body?.data ||
        []) as ApiConsultation[];
      const apiSubscriptions = (interceptions[1].response?.body?.data ||
        []) as ApiSubscription[];
      const apiWebinars = (interceptions[2].response?.body?.data ||
        []) as ApiWebinar[];
      const apiClasses = (interceptions[3].response?.body?.data ||
        []) as ApiClass[];

      const allSlots = getAllSlots(
        apiConsultations,
        apiSubscriptions,
        apiWebinars,
        apiClasses,
      );

      if (allSlots.length === 0) {
        cy.log("No slots found, skipping navigation test.");
        return;
      }

      cy.get('[data-testid="appointment-item"]').first().click();

      const firstSlot = allSlots[0];
      let expectedUrlPart = "";
      if (firstSlot.appointmentType === "Consultation") {
        expectedUrlPart = `/consultations/${firstSlot.eventDetails.id}`;
      } else if (firstSlot.appointmentType === "Subscription") {
        expectedUrlPart = `/subscriptions/${firstSlot.eventDetails.id}`;
      } else if (firstSlot.appointmentType === "Webinar") {
        expectedUrlPart = `/webinars/${firstSlot.eventDetails.id}`;
      } else if (firstSlot.appointmentType === "Class") {
        expectedUrlPart = `/classes/${firstSlot.eventDetails.id}`;
      }

      const expectedPath = `/dashboard/consultant/${dynamicConsultantId}/appointments${expectedUrlPart}`;

      if (expectedPath) {
        cy.url().should("include", expectedPath);
      }
    });
  });
});
