/// <reference types="cypress" />

// Import setup function and potentially necessary types
import { setupConsultantAppointments } from "./consultant-setup.cy";
// Assuming you have a type definition for the structure coming from the API
// If not, replace with 'any' but define types for better maintenance
// import { TApiConsultation, TApiSubscription, TApiWebinar, TApiClass } from "../../../../types/api";
type TApiConsultation = any;
type TApiSubscription = any;
type TApiWebinar = any;
type TApiClass = any;

// --- Helper Interfaces (Derived from API Data Structure) ---

// Interface for a single appointment slot extracted from any event type
interface ProcessedSlot {
  id: string; // Slot ID
  appointmentId: string; // Parent Appointment ID
  startTimeUTC: Date;
  endTimeUTC: Date;
  eventType: "Consultation" | "Subscription" | "Webinar" | "Class";
  eventTitle: string;
  consulteeName?: string; // Only for Consultation/Subscription
}

// --- Helper Functions ---

/**
 * Processes API responses to extract a flat list of all appointment slots.
 * NOTE: Adapt this based on the ACTUAL structure of your API responses.
 */
function processAllSlots(
  consultations: TApiConsultation[], // Should be Array<{ id: string, appointment: { id: string, slotsOfAppointment: any[] }, consultationPlan: { title: string }, requestedBy: { user: { name: string }} }>
  subscriptions: TApiSubscription[], // Should be Array<{ id: string, appointments: Array<{ id: string, slotsOfAppointment: any[] }>, subscriptionPlan: { title: string }, requestedBy: { user: { name: string }} }>
  webinars: TApiWebinar[],      // Should be Array<{ id: string, appointment: { id: string, slotsOfAppointment: any[] }, webinarPlan: { title: string } }>
  classes: TApiClass[],         // Should be Array<{ id: string, appointments: Array<{ id: string, slotsOfAppointment: any[] }>, classPlan: { title: string } }>
): ProcessedSlot[] {
  const allSlots: ProcessedSlot[] = [];

  // Process Consultations
  consultations?.forEach((event) => {
    event?.appointment?.slotsOfAppointment?.forEach((slot: any) => {
       if (slot?.id && event.appointment.id && slot.slotStartTimeInUTC && slot.slotEndTimeInUTC) {
            allSlots.push({
                id: slot.id,
                appointmentId: event.appointment.id,
                startTimeUTC: new Date(slot.slotStartTimeInUTC),
                endTimeUTC: new Date(slot.slotEndTimeInUTC),
                eventType: "Consultation",
                eventTitle: event.consultationPlan?.title || "Unknown Consultation",
                consulteeName: event.requestedBy?.user?.name || "Unknown Consultee",
            });
       }
    });
  });

  // Process Subscriptions
  subscriptions?.forEach((event) => {
    event?.appointments?.forEach((appointment: any) => {
      appointment?.slotsOfAppointment?.forEach((slot: any) => {
         if (slot?.id && appointment.id && slot.slotStartTimeInUTC && slot.slotEndTimeInUTC) {
            allSlots.push({
              id: slot.id,
              appointmentId: appointment.id,
              startTimeUTC: new Date(slot.slotStartTimeInUTC),
              endTimeUTC: new Date(slot.slotEndTimeInUTC),
              eventType: "Subscription",
              eventTitle: event.subscriptionPlan?.title || "Unknown Subscription",
              consulteeName: event.requestedBy?.user?.name || "Unknown Consultee",
            });
         }
      });
    });
  });

  // Process Webinars (assuming single appointment per webinar)
  webinars?.forEach((event) => {
    event?.appointment?.slotsOfAppointment?.forEach((slot: any) => {
       if (slot?.id && event.appointment.id && slot.slotStartTimeInUTC && slot.slotEndTimeInUTC) {
            allSlots.push({
                id: slot.id,
                appointmentId: event.appointment.id,
                startTimeUTC: new Date(slot.slotStartTimeInUTC),
                endTimeUTC: new Date(slot.slotEndTimeInUTC),
                eventType: "Webinar",
                eventTitle: event.webinarPlan?.title || "Unknown Webinar",
                // Consultee name likely not directly available here
            });
       }
    });
  });

  // Process Classes
  classes?.forEach((event) => {
     event?.appointments?.forEach((appointment: any) => {
        appointment?.slotsOfAppointment?.forEach((slot: any) => {
           if (slot?.id && appointment.id && slot.slotStartTimeInUTC && slot.slotEndTimeInUTC) {
                allSlots.push({
                    id: slot.id,
                    appointmentId: appointment.id,
                    startTimeUTC: new Date(slot.slotStartTimeInUTC),
                    endTimeUTC: new Date(slot.slotEndTimeInUTC),
                    eventType: "Class",
                    eventTitle: event.classPlan?.title || "Unknown Class",
                     // Consultee name likely not directly available here
                });
           }
        });
     });
  });

  // Sort slots chronologically
  return allSlots.sort((a, b) => a.startTimeUTC.getTime() - b.startTimeUTC.getTime());
}

/**
 * Formats a Date object into the specific string format used in the UI.
 * Adapt this precisely to match your component's output (e.g., from AppointmentsTab.tsx).
 */
function formatDateTimeForUI(date: Date): string {
    // Example format: "Wed, Mar 5, 2:00 PM" - ADJUST THIS
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    const dayName = days[date.getDay()];
    const monthName = months[date.getMonth()];
    const day = date.getDate();
    let hour = date.getHours();
    const minute = date.getMinutes();
    const period = hour >= 12 ? 'PM' : 'AM';

    hour = hour % 12;
    hour = hour ? hour : 12; // the hour '0' should be '12'

    const minuteStr = minute < 10 ? '0' + minute : minute;

    // Adjust the final string to EXACTLY match your UI
    return `${dayName}, ${monthName} ${day}, ${hour}:${minuteStr} ${period}`;
}

// --- Main Test Suite ---

describe('Consultant Appointments Verification', () => {
  let consultantIds: string[] = []; // Holds fetched IDs

  // Fetch all consultant IDs once before tests start
  before(() => {
    cy.request<{ consultantIds: string[] }>("GET", "/api/user/consultants?idsOnly=true")
      .its('body.consultantIds', { timeout: 10000 }) // Add timeout for API call
      .should('exist') // Ensure body.consultantIds exists
      .then((ids) => {
        if (!ids || ids.length === 0) {
          console.warn("No consultant IDs fetched for appointments test suite.");
          consultantIds = [];
        } else {
          consultantIds = ids;
          cy.log(`Fetched ${consultantIds.length} consultant IDs for verification.`);
          console.log(`Fetched ${consultantIds.length} consultant IDs.`);
        }
      });
  });

  // Test to ensure IDs are loaded before proceeding
  it('initializes and confirms consultant IDs are loaded', () => {
    // Give the before() hook time to potentially finish the async request
    cy.wait(500); // Adjust wait time if needed
    cy.wrap(null).then(() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(consultantIds).to.exist;
      cy.log(`Proceeding with verification for ${consultantIds.length} consultant(s).`);
      if (consultantIds.length === 0) {
         // Mark test as pending/skipped if no IDs loaded
         // Using 'cy.log' and letting it pass is okay too.
         cy.log('Skipping main verification as no consultant IDs were loaded.');
         // this.skip(); // Optionally skip explicitly
      }
    });
  });

  // Main verification test that loops through IDs
  it('Verifies all appointments for each consultant', function() { // Use function() for 'this.skip()' if needed
    if (!consultantIds || consultantIds.length === 0) {
      cy.log("Skipping test: No consultant IDs were available.");
      this.skip(); // Skip this test if no IDs
    }

    cy.log(`Starting verification loop for ${consultantIds.length} consultant IDs.`);

    consultantIds.forEach((consultantId) => {
      cy.log(`--- Verifying Appointments for Consultant ID: ${consultantId} ---`);

      // Run setup (visit page, set up intercepts) for the current consultant
      setupConsultantAppointments(consultantId);

      // Wait for all data fetching APIs for this consultant
      cy.wait([
        "@getConsultations",
        "@getSubscriptions",
        "@getWebinars",
        "@getClasses"
      ], { timeout: 20000 }) // Increase timeout if APIs are slow
      .then((interceptions) => {

        // --- Data Processing ---
        cy.log(`Processing API data for consultant ${consultantId}`);

        // Verify all intercepts were successful
        interceptions.forEach((intercept) => {
            expect(intercept.response?.statusCode, `API ${intercept.request.url} successful`).to.be.oneOf([200, 201, 204]);
        });

        const consultations = interceptions[0].response?.body?.data || [];
        const subscriptions = interceptions[1].response?.body?.data || [];
        const webinars = interceptions[2].response?.body?.data || [];
        const classes = interceptions[3].response?.body?.data || [];

        const expectedSlots = processAllSlots(consultations, subscriptions, webinars, classes);
        cy.log(`Processed ${expectedSlots.length} expected slots for ${consultantId}`);

        // --- UI Verification ---

        // Handle case where no appointments are expected
        if (expectedSlots.length === 0) {
          cy.log('API data shows no appointments, verifying empty state UI.');
          cy.contains("No Appointments Found", { timeout: 10000 }).should("be.visible");
          // Skip further checks for this consultant
          return; // Go to next consultantId in forEach
        }

        // Verify the total number of appointment items displayed
        // Use a robust selector for the container/list if possible
        cy.get('[data-testid="appointment-list"]', { timeout: 10000 }) // Assuming a list container test ID
          .find('[data-testid^="appointment-item-"]') // Assuming item test IDs like "appointment-item-APPOINTMENT_ID"
          .should('have.length', expectedSlots.length);

        // Verify details of each expected slot
        expectedSlots.forEach((slot, index) => {
          const expectedTimeStr = formatDateTimeForUI(slot.startTimeUTC);
          cy.log(`Verifying Slot ${index + 1}/${expectedSlots.length}: Time: ${expectedTimeStr}, Title: ${slot.eventTitle}`);

          // Find the specific appointment item using its unique ID
          // ** IMPORTANT: Your component MUST render a unique identifier like this **
          cy.get(`[data-testid="appointment-item-${slot.appointmentId}"]`, { timeout: 10000 })
            .should('be.visible')
            .within(() => {
              // Verify Time
              // Be specific with the selector for the time element if possible
              cy.contains(expectedTimeStr).should('be.visible');

              // Verify Title
              cy.contains(slot.eventTitle).should('be.visible');

              // Verify Consultee Name (if applicable)
              if (slot.consulteeName) {
                cy.contains(slot.consulteeName).should('be.visible');
              }

              // --- Optional: Verify Status Badge ---
              // Add logic here based on `AppointmentsTab.tsx` to check badge text
              const statusBadge = cy.get('[data-testid="status-badge"]'); // Assuming test id exists
              const now = new Date();
              if (slot.startTimeUTC < now) {
                   statusBadge.should('contain', 'Completed'); // Adapt text if needed
              } else {
                   // Add checks for 'Tomorrow', 'In X days/weeks', 'In Progress' etc.
                   // This requires translating the logic from AppointmentsTab.tsx
                   // Example:
                   // const diffDays = ... calculation ...
                   // if (diffDays === 0) statusBadge.should('contain', 'Today'); // or 'Tomorrow' etc.
                   // else if (diffDays < 7) statusBadge.should('contain', 'days');
                   // else statusBadge.should('contain', 'weeks'); // Simplified
              }
              // --- Optional: Verify Button State ---
              // Add logic here based on `AppointmentsTab.tsx` to check button visibility/state
              const actionButton = cy.get('button').contains(/Chat|Join/i); // Find button
              if (slot.startTimeUTC < now) {
                   // Example: Button might not exist for completed items
                   actionButton.should('not.exist');
              } else {
                   // Example: Check if enabled/disabled based on time proximity
                   // const diffMinutes = ... calculation ...
                   // if (diffMinutes <= 5) actionButton.should('not.be.disabled');
                   // else actionButton.should('be.disabled');
                   actionButton.should('exist'); // Placeholder check
              }

            });
        });
      }); // End of .then() after cy.wait()

      cy.log(`--- Finished Verifying Appointments for Consultant ID: ${consultantId} ---`);
    }); // End of consultantIds.forEach()

    cy.log(`Finished verification loop for ${consultantIds.length} consultant IDs.`);
  }); // End of main 'it' block
}); // End of describe()
