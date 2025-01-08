import { TAppointment } from "../../../types/appointment";
import consultantIdsFixture from "../../fixtures/consultant-ids.json";
import { setupConsultantAppointments } from "./setup.cy";

interface ConsultantIdsFixture {
  consultantIds: string[];
}

type Event = {
  appointment?: TAppointment;
  appointments?: TAppointment[];
};

type SlotWithAppointment = TAppointment['slotsOfAppointment'][0] & {
  appointment: TAppointment;
};

function getAllSlots(events: Event[]): SlotWithAppointment[] {
  return events.flatMap((event) => {
    if (event.appointment?.slotsOfAppointment) {
      return event.appointment.slotsOfAppointment.map(slot => ({
        ...slot,
        appointment: event.appointment!
      }));
    }
    if (event.appointments) {
      return event.appointments.flatMap(apt => 
        (apt.slotsOfAppointment || []).map(slot => ({
          ...slot,
          appointment: apt
        }))
      );
    }
    return [];
  });
}

function formatDateTime(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  const dayName = days[date.getDay()];
  const monthName = months[date.getMonth()];
  const day = date.getDate();
  const hour = date.getHours() % 12 || 12;
  const minute = date.getMinutes().toString().padStart(2, '0');
  const period = date.getHours() < 12 ? 'AM' : 'PM';

  return `${dayName}, ${monthName} ${day}, ${hour}:${minute} ${period}`;
}

(consultantIdsFixture as unknown as ConsultantIdsFixture).consultantIds.forEach(
  (consultantId) => {
    describe(`Consultant Appointments Page - ID: ${consultantId}`, () => {
      beforeEach(() => {
        setupConsultantAppointments(consultantId);
      });

      it("verifies appointments from API match UI", () => {
        // Get all events from API responses
        cy.wait([
          "@getConsultations",
          "@getSubscriptions",
          "@getWebinars",
          "@getClasses"
        ]).then((interceptions) => {
          const [consultationsReq, subscriptionsReq, webinarsReq, classesReq] = interceptions;
          const consultations = consultationsReq.response?.body?.data || [];
          const subscriptions = subscriptionsReq.response?.body?.data || [];
          const webinars = webinarsReq.response?.body?.data || [];
          const classes = classesReq.response?.body?.data || [];

          // Process all slots
          const allEvents = [...consultations, ...subscriptions, ...webinars, ...classes];
          const allSlots = getAllSlots(allEvents);

          // Sort slots by time
          const sortedSlots = allSlots.sort((a, b) =>
            new Date(a.slotStartTimeInUTC).getTime() - new Date(b.slotStartTimeInUTC).getTime()
          );

          // Verify each slot appears in UI
          sortedSlots.forEach((slot) => {
            const formattedTime = formatDateTime(new Date(slot.slotStartTimeInUTC));

            // Find the appointment in UI
            cy.contains(formattedTime)
              .closest('[data-testid="appointment-item"]')
              .within(() => {
                // Verify appointment type and details
                const appointment = slot.appointment;
                if (appointment.consultation) {
                  cy.contains(`Consultation - ${appointment.consultation.consultationPlan.title}`);
                  cy.contains(appointment.consultation.consultationPlan.consultantProfile?.user?.name || '');
                } else if (appointment.subscription) {
                  cy.contains(`Subscription - ${appointment.subscription.subscriptionPlan.title}`);
                  cy.contains(appointment.subscription.subscriptionPlan.consultantProfile?.user?.name || '');
                } else if (appointment.webinar) {
                  cy.contains(`Webinar - ${appointment.webinar.webinarPlan.title}`);
                } else if (appointment.class) {
                  cy.contains(`Class - ${appointment.class.classPlan.title}`);
                }

                // Verify time format
                cy.contains(formattedTime);
              });
          });

          // Verify total count matches
          cy.get('[data-testid="appointment-item"]').should('have.length', sortedSlots.length);

          // Verify empty state if no appointments
          if (sortedSlots.length === 0) {
            cy.contains('No Appointments Found').should('be.visible');
          }
        });
      });

      it("verifies timezone conversion", () => {
        // Get all events and verify their times
        cy.wait([
          "@getConsultations",
          "@getSubscriptions",
          "@getWebinars",
          "@getClasses"
        ]).then((interceptions) => {
          const [consultationsReq, subscriptionsReq, webinarsReq, classesReq] = interceptions;
          const consultations = consultationsReq.response?.body?.data || [];
          const subscriptions = subscriptionsReq.response?.body?.data || [];
          const webinars = webinarsReq.response?.body?.data || [];
          const classes = classesReq.response?.body?.data || [];

          const allEvents = [...consultations, ...subscriptions, ...webinars, ...classes];
          const allSlots = getAllSlots(allEvents);

          allSlots.forEach((slot) => {
            const utcTime = new Date(slot.slotStartTimeInUTC);
            const expectedTime = formatDateTime(utcTime);

            // Verify the time shown in UI matches expected time in user's timezone
            cy.contains(expectedTime).should("exist");
          });
        });
      });

      it("verifies chronological order", () => {
        cy.wait([
          "@getConsultations",
          "@getSubscriptions",
          "@getWebinars",
          "@getClasses"
        ]).then((interceptions) => {
          const [consultationsReq, subscriptionsReq, webinarsReq, classesReq] = interceptions;
          const consultations = consultationsReq.response?.body?.data || [];
          const subscriptions = subscriptionsReq.response?.body?.data || [];
          const webinars = webinarsReq.response?.body?.data || [];
          const classes = classesReq.response?.body?.data || [];

          const allEvents = [...consultations, ...subscriptions, ...webinars, ...classes];
          const allSlots = getAllSlots(allEvents);

          // Sort slots by time
          const sortedSlots = allSlots.sort((a, b) =>
            new Date(a.slotStartTimeInUTC).getTime() - new Date(b.slotStartTimeInUTC).getTime()
          );

          // Verify appointments appear in chronological order
          let previousTime = new Date(0);
          sortedSlots.forEach((slot) => {
            const currentTime = new Date(slot.slotStartTimeInUTC);
            expect(currentTime.getTime()).to.be.at.least(previousTime.getTime());
            previousTime = currentTime;
          });
        });
      });

      it("verifies status badges and join button states", () => {
        cy.wait([
          "@getConsultations",
          "@getSubscriptions",
          "@getWebinars",
          "@getClasses"
        ]).then((interceptions) => {
          const [consultationsReq, subscriptionsReq, webinarsReq, classesReq] = interceptions;
          const consultations = consultationsReq.response?.body?.data || [];
          const subscriptions = subscriptionsReq.response?.body?.data || [];
          const webinars = webinarsReq.response?.body?.data || [];
          const classes = classesReq.response?.body?.data || [];

          const allEvents = [...consultations, ...subscriptions, ...webinars, ...classes];
          const allSlots = getAllSlots(allEvents);

          allSlots.forEach((slot) => {
            const now = new Date();
            const appointmentTime = new Date(slot.slotStartTimeInUTC);
            const formattedTime = formatDateTime(appointmentTime);
            const diffInMinutes = (appointmentTime.getTime() - now.getTime()) / (1000 * 60);
            const diffInDays = Math.ceil(diffInMinutes / (24 * 60));

            cy.contains(formattedTime)
              .closest('[data-testid="appointment-item"]')
              .within(() => {
                // Verify status badge
                if (appointmentTime < now) {
                  cy.get('[data-testid="status-badge"]').should('contain', 'Completed');
                } else if (diffInDays <= 7) {
                  cy.get('[data-testid="status-badge"]').should('contain', 'days');
                } else if (diffInDays <= 30) {
                  cy.get('[data-testid="status-badge"]').should('contain', 'weeks');
                } else {
                  cy.get('[data-testid="status-badge"]').should('contain', 'months');
                }

                // Verify join button state
                const joinButton = cy.get('button').contains('Join meet');
                if (diffInMinutes < 0) {
                  joinButton.should('be.disabled');
                } else if (diffInMinutes <= 5) {
                  joinButton.should('not.be.disabled');
                } else {
                  joinButton.should('be.disabled');
                }
              });
          });
        });
      });

      it("handles API errors gracefully", () => {
        // Mock API errors
        cy.intercept(
          "GET",
          `/api/events/consultations?consultantProfileId=${consultantId}`,
          { statusCode: 500, body: { error: "Server error" } }
        ).as("failedConsultations");

        cy.intercept(
          "GET",
          `/api/events/subscriptions?consultantProfileId=${consultantId}`,
          { statusCode: 500, body: { error: "Server error" } }
        ).as("failedSubscriptions");

        cy.intercept(
          "GET",
          `/api/events/webinars?consultantProfileId=${consultantId}`,
          { statusCode: 500, body: { error: "Server error" } }
        ).as("failedWebinars");

        cy.intercept(
          "GET",
          `/api/events/classes?consultantProfileId=${consultantId}`,
          { statusCode: 500, body: { error: "Server error" } }
        ).as("failedClasses");

        // Visit page and verify error state
        cy.visit(`/dashboard/consultant/${consultantId}/appointments`);
        cy.contains('Error loading appointments').should('be.visible');
      });
    });
  }
);
