/// <reference types="cypress" />

import { setupConsulteeDashboard } from "./consultee-setup.cy";
import consulteeIdsFixture from "../../fixtures/consultee-ids.json";

interface ConsulteeIdsFixture {
  consulteeIds: string[];
}

(consulteeIdsFixture as unknown as ConsulteeIdsFixture).consulteeIds.forEach(
  (consulteeId) => {
    describe(`Consultee Dashboard - Home Page (ID: ${consulteeId})`, () => {
      beforeEach(() => {
        setupConsulteeDashboard(consulteeId, 'home');
      });

      describe("Upcoming Sessions Section", () => {
        it("displays event details and status badges correctly", { defaultCommandTimeout: 30000 }, () => {
          cy.wait([
            "@getConsultations",
            "@getSubscriptions",
            "@getWebinars",
            "@getClasses",
          ]).then(([consultationsResp, subscriptionsResp, webinarsResp, classesResp]) => {
            // Verify each event type
            const eventTypes = [
              { type: 'Webinar', response: webinarsResp },
              { type: 'Consultation', response: consultationsResp },
              { type: 'Class', response: classesResp },
              { type: 'Subscription', response: subscriptionsResp }
            ];

            eventTypes.forEach(({ type, response }) => {
              const events = response.response?.body.data || [];
              events.forEach((event: any) => {
                const eventId = event.id;
                const testId = `${type.toLowerCase()}-${eventId}`;

                cy.get(`[data-testid="${testId}"]`).within(() => {
                  // Verify event type badge
                  cy.get(`[data-testid="event-type"]`).should('contain', type);

                  // Verify consultant name
                  const consultantName = event[`${type.toLowerCase()}Plan`]?.consultantProfile?.user?.name;
                  if (consultantName) {
                    cy.get('[data-testid="consultant-name"]').should('contain', consultantName);
                  }

                  // Verify status badge
                  const status = event.status || event.requestStatus;
                  cy.get('[data-testid="event-status"]').should('contain', status);

                  // Verify date format
                  cy.get('[data-testid="event-datetime"]').invoke('text').should('match', /\w+, \d{1,2} \w+ \d{4}/);
                });
              });
            });
          });
        });

        it("handles carousel navigation correctly", { defaultCommandTimeout: 30000 }, () => {
          cy.wait([
            "@getConsultations",
            "@getSubscriptions",
            "@getWebinars",
            "@getClasses",
          ]).then(() => {
            cy.get('[data-testid="upcoming-slot-list"]').then(($list) => {
              if ($list[0].scrollWidth > $list[0].clientWidth) {
                // Get initial first event
                cy.get('[data-testid^="event-card-"]').first().invoke('attr', 'data-testid').as('firstEventId');

                // Click next button and verify scroll
                cy.get('[data-testid="next-slot"]').click();
                cy.get('[data-testid="upcoming-slot-list"]').should(($newList) => {
                  expect($newList[0].scrollLeft).to.be.greaterThan(0);
                });

                // Click previous button and verify back to start
                cy.get('[data-testid="prev-slot"]').click();
                cy.get('@firstEventId').then((firstEventId) => {
                  cy.get(`[data-testid="${firstEventId}"]`).should('be.visible');
                });
              }
            });
          });
        });
      });

      describe("Monthly Events Section", () => {
        it("navigates between months and displays events correctly", { defaultCommandTimeout: 30000 }, () => {
          cy.wait([
            "@getConsultations",
            "@getSubscriptions",
            "@getWebinars",
            "@getClasses",
          ]).then(() => {
            // Get current month/year
            cy.get('[data-testid="month-nav"]').find('h2')
              .invoke('text')
              .then((currentMonthYear) => {
                // Click next month
                cy.get('[data-testid="next-month"]').click();
                
                // Verify month changed
                cy.get('[data-testid="month-nav"]').find('h2')
                  .should('not.contain', currentMonthYear);

                // Click previous month
                cy.get('[data-testid="prev-month"]').click();
                
                // Verify back to original month
                cy.get('[data-testid="month-nav"]').find('h2')
                  .should('contain', currentMonthYear);
              });

            // Verify event slots format
            cy.get('[data-testid="monthly-slot"]').each(($slot) => {
              cy.wrap($slot).within(() => {
                // Verify date format
                cy.get('[data-testid="slot-date"]')
                  .invoke('text')
                  .should('match', /(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Za-z]{3}/);

                // Verify time format
                cy.get('[data-testid="slot-time"]')
                  .invoke('text')
                  .should('match', /\d{1,2}:\d{2} [ap]m - \d{1,2}:\d{2} [ap]m/);
              });
            });
          });
        });

        it("handles tentative slots and status badges", { defaultCommandTimeout: 30000 }, () => {
          cy.wait([
            "@getConsultations",
            "@getSubscriptions",
            "@getWebinars",
            "@getClasses",
          ]).then(([consultationsResp, subscriptionsResp, webinarsResp, classesResp]) => {
            const allEvents = [
              ...(consultationsResp.response?.body.data || []),
              ...(subscriptionsResp.response?.body.data || []),
              ...(webinarsResp.response?.body.data || []),
              ...(classesResp.response?.body.data || []),
            ];

            // Check for tentative slots
            const hasTentativeSlots = allEvents.some((event) => {
              const slots = event.appointments
                ? event.appointments.flatMap((a: any) => a.slotsOfAppointment || [])
                : event.appointment?.slotsOfAppointment || [];

              return slots.some((slot: any) => slot.isTentative);
            });

            if (hasTentativeSlots) {
              cy.get('[data-testid="tentative-notice"]')
                .should("exist")
                .should("contain", "*Subject to change");
            }

            // Verify status badges
            const statusTypes = ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'APPROVED', 'PENDING'];
            statusTypes.forEach(status => {
              const hasStatus = allEvents.some(event => 
                (event.status || event.requestStatus) === status
              );
              
              if (hasStatus) {
                cy.get('[data-testid="event-status"]')
                  .contains(status)
                  .should("exist");
              }
            });
          });
        });
      });
    });
  },
);
