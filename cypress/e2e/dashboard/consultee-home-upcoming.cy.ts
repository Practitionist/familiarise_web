/// <reference types="cypress" />

import { setupConsulteeDashboard } from "./consultee-setup.cy";
import consulteeIdsFixture from "../../fixtures/consultee-ids.json";

interface ConsulteeIdsFixture {
  consulteeIds: string[];
}

(consulteeIdsFixture as unknown as ConsulteeIdsFixture).consulteeIds.forEach((consulteeId) => {
  describe(`Consultee Dashboard - Home Tab Upcoming Sessions (ID: ${consulteeId})`, () => {
    beforeEach(() => {
      setupConsulteeDashboard(consulteeId);
    });

    afterEach(function () {
      if (this.currentTest?.state === "failed") {
        cy.writeFile(
          "cypress/logs/errors.json",
          {
            timestamp: new Date().toISOString(),
            test: this.currentTest.title,
            error: this.currentTest.err?.message,
            stack: this.currentTest.err?.stack,
          },
          { flag: "a+" },
        );
      }
    });

    // Log uncaught exceptions
    Cypress.on("uncaught:exception", (err) => {
      cy.writeFile(
        "cypress/logs/uncaught-errors.json",
        {
          timestamp: new Date().toISOString(),
          error: err.message,
          stack: err.stack,
        },
        { flag: "a+" },
      );
      return false;
    });

    it(
      "displays correct status badges and allows carousel navigation",
      { defaultCommandTimeout: 30000 },
      () => {
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "test_start",
            test: "displays correct status badges in upcoming sessions",
          });
          cy.writeFile("cypress/logs/info.json", logs);
        });

        // Wait for all API responses
        cy.wait([
          "@getConsultations",
          "@getSubscriptions",
          "@getWebinars",
          "@getClasses",
        ]).then(([consultationsResp, subscriptionsResp, webinarsResp, classesResp]) => {
          const consultations = consultationsResp.response?.body.data || [];
          const subscriptions = subscriptionsResp.response?.body.data || [];
          const webinars = webinarsResp.response?.body.data || [];
          const classes = classesResp.response?.body.data || [];

          // Verify carousel navigation if there are events
          if (consultations.length + subscriptions.length + webinars.length + classes.length > 0) {
            // Get initial first event ID
            cy.get('[data-testid^="consultation-"], [data-testid^="subscription-"], [data-testid^="webinar-"], [data-testid^="class-"]')
              .first()
              .invoke('attr', 'data-testid')
              .then((firstEventId) => {
                // Click right arrow until we see a different event
                cy.get('[data-testid="upcoming-slot-list"]').then(($list) => {
                  if ($list[0].scrollWidth > $list[0].clientWidth) {
                    cy.get('button').contains('arrow_right').click();
                    // Verify scroll position changed
                    cy.get('[data-testid="upcoming-slot-list"]').should(($newList) => {
                      expect($newList[0].scrollLeft).to.be.greaterThan(0);
                    });
                    // Click left arrow to go back
                    cy.get('button').contains('arrow_left').click();
                    // Verify we're back at the start
                    cy.get('[data-testid^="consultation-"], [data-testid^="subscription-"], [data-testid^="webinar-"], [data-testid^="class-"]')
                      .first()
                      .should('have.attr', 'data-testid', firstEventId);
                  }
                });
              });
          }

          // Verify status badges and chronological order
          const allEvents = [
            ...consultations.map(c => ({ ...c, type: 'consultation', status: c.requestStatus })),
            ...subscriptions.map(s => ({ ...s, type: 'subscription', status: s.requestStatus })),
            ...webinars.map(w => ({ ...w, type: 'webinar', status: w.status })),
            ...classes.map(c => ({ ...c, type: 'class', status: c.status }))
          ];

          allEvents.forEach((event: any) => {
            cy.get(`[data-testid="${event.type}-${event.id}"]`)
              .first()
              .should("exist")
              .within(() => {
                // Verify status badge
                cy.get('[data-testid="event-status"]').should(
                  "contain",
                  event.status
                );

                // Verify "Starting Soon!" badge for events within 10 minutes
                if (event.scheduledAt || event.preferredDateTime || event.tentativeSchedule) {
                  const eventTime = new Date(event.scheduledAt || event.preferredDateTime || JSON.parse(event.tentativeSchedule)[0].startTime);
                  const now = new Date();
                  const diffInMinutes = Math.floor((eventTime.getTime() - now.getTime()) / 60000);
                  
                  if (diffInMinutes <= 10 && diffInMinutes >= 0) {
                    cy.get('.bg-green-100.text-green-800').should('contain', 'Starting Soon!');
                  }
                }
              });
          });

          // Verify chronological order
          cy.get('[data-testid="slot-datetime"]').then($slots => {
            const dates = $slots.map((_, el) => {
              const text = Cypress.$(el).text();
              const match = text.match(/[A-Za-z]{3}, \d{1,2} [A-Za-z]{3} \d{4}/);
              if (!match) {
                throw new Error(`Invalid date format in text: ${text}`);
              }
              return new Date(match[0]);
            }).get();

            // Check if dates are in ascending order
            for (let i = 1; i < dates.length; i++) {
              expect(dates[i].getTime()).to.be.at.least(dates[i-1].getTime());
            }
          });
        });
      },
    );

    it(
      "shows correct consultant information",
      { defaultCommandTimeout: 30000 },
      () => {
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "test_start",
            test: "shows correct consultant information in upcoming sessions",
          });
          cy.writeFile("cypress/logs/info.json", logs);
        });

        // Helper function to get the correct data-testid prefix
        const getTestIdPrefix = (eventType: string) => {
          return eventType === "classes" ? "class" : eventType.slice(0, -1);
        };

        ["consultations", "subscriptions", "classes"].forEach((eventType) => {
          cy.wait(
            `@get${eventType.charAt(0).toUpperCase() + eventType.slice(1)}`,
          ).then((interception) => {
            const events = interception.response?.body.data;
            events.forEach((event: any) => {
              const consultantName =
                event.consultationPlan?.consultantProfile?.user?.name ||
                event.subscriptionPlan?.consultantProfile?.user?.name ||
                event.classPlan?.consultantProfile?.user?.name;

              if (consultantName) {
                const testIdPrefix = getTestIdPrefix(eventType);
                cy.get(`[data-testid="${testIdPrefix}-${event.id}"]`)
                  .first()
                  .should("exist")
                  .within(() => {
                    cy.get('[data-testid="consultant-name"]').should(
                      "contain",
                      consultantName,
                    );
                  });
              }
            });
          });
        });
      },
    );
  });
});
