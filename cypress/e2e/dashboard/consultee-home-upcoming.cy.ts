/// <reference types="cypress" />

import { setupConsulteeDashboard } from "./consultee-setup.cy";
import consulteeIdsFixture from "../../fixtures/consultee-ids.json";

interface ConsulteeIdsFixture {
  consulteeIds: string[];
}

(consulteeIdsFixture as unknown as ConsulteeIdsFixture).consulteeIds.forEach(
  (consulteeId) => {
    describe(`Consultee Dashboard - Home Tab Upcoming Sessions (ID: ${consulteeId})`, () => {
      beforeEach(() => {
        setupConsulteeDashboard(consulteeId, 'home');
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
          ]).then(
            ([
              consultationsResp,
              subscriptionsResp,
              webinarsResp,
              classesResp,
            ]) => {
              const consultations = consultationsResp.response?.body.data || [];
              const subscriptions = subscriptionsResp.response?.body.data || [];
              const webinars = webinarsResp.response?.body.data || [];
              const classes = classesResp.response?.body.data || [];

              // Verify carousel navigation if there are events
              if (
                consultations.length +
                  subscriptions.length +
                  webinars.length +
                  classes.length >
                0
              ) {
                // Get initial first event ID
                cy.get(
                  '[data-testid^="consultation-"], [data-testid^="subscription-"], [data-testid^="webinar-"], [data-testid^="class-"]',
                )
                  .first()
                  .invoke("attr", "data-testid")
                  .then((firstEventId) => {
                    // Click right arrow until we see a different event
                    cy.get('[data-testid="upcoming-slot-list"]').then(
                      ($list) => {
                        if ($list[0].scrollWidth > $list[0].clientWidth) {
                          // Click right arrow
                          cy.get('[data-testid="next-slot"]').click();
                          // Verify scroll position changed
                          cy.get('[data-testid="upcoming-slot-list"]').should(
                            ($newList) => {
                              expect($newList[0].scrollLeft).to.be.greaterThan(
                                0,
                              );
                            },
                          );
                          // Click left arrow
                          cy.get('[data-testid="prev-slot"]').click();
                          // Verify we're back at the start
                          cy.get(
                            '[data-testid^="consultation-"], [data-testid^="subscription-"], [data-testid^="webinar-"], [data-testid^="class-"]',
                          )
                            .first()
                            .should("have.attr", "data-testid", firstEventId);
                        }
                      },
                    );
                  });
              }

              // Process events with valid slots
              const allEvents = [
                ...consultations
                  .filter((c) => c.appointment?.slotsOfAppointment?.length > 0)
                  .map((c) => ({
                    ...c,
                    type: "consultation",
                    status: c.requestStatus,
                  })),
                ...subscriptions
                  .filter((s) =>
                    s.appointments?.some(
                      (a) => a.slotsOfAppointment?.length > 0,
                    ),
                  )
                  .map((s) => ({
                    ...s,
                    type: "subscription",
                    status: s.requestStatus,
                  })),
                ...webinars
                  .filter((w) => w.appointment?.slotsOfAppointment?.length > 0)
                  .map((w) => ({ ...w, type: "webinar", status: w.status })),
                ...classes
                  .filter((c) =>
                    c.appointments?.some(
                      (a) => a.slotsOfAppointment?.length > 0,
                    ),
                  )
                  .map((c) => ({ ...c, type: "class", status: c.status })),
              ];

              // Only verify events that have valid dates
              if (allEvents.length > 0) {
                // Then verify each event
                allEvents.forEach((event: any) => {
                  cy.get(`[data-testid="${event.type}-${event.id}"]`)
                    .first()
                    .should("exist")
                    .within(() => {
                      // Verify status badge
                      cy.get('[data-testid="event-status"]').should(
                        "contain",
                        event.status,
                      );

                      // Verify "Starting Soon!" badge for events with slots within 10 minutes
                      const slots = event.appointments
                        ? event.appointments.flatMap(
                            (a) => a.slotsOfAppointment || [],
                          )
                        : event.appointment?.slotsOfAppointment || [];

                      const nextSlot = slots
                        .map((slot) => new Date(slot.slotStartTimeInUTC))
                        .sort((a, b) => a.getTime() - b.getTime())
                        .find((date) => {
                          const now = new Date();
                          const diffInMinutes = Math.floor(
                            (date.getTime() - now.getTime()) / 60000,
                          );
                          return diffInMinutes <= 10 && diffInMinutes >= 0;
                        });

                      if (nextSlot) {
                        cy.get(".bg-green-100.text-green-800").should(
                          "contain",
                          "Starting Soon!",
                        );
                      }
                    });
                });

                // Verify chronological order
                cy.get('[data-testid="slot-datetime"]').then(($slots) => {
                  const dates = $slots
                    .map((_, el) => {
                      const text = Cypress.$(el).text();
                      const match = text.match(
                        /[A-Za-z]{3}, \d{1,2} [A-Za-z]{3} \d{4}/,
                      );
                      if (!match) {
                        throw new Error(`Invalid date format in text: ${text}`);
                      }
                      return new Date(match[0]);
                    })
                    .get();

                  // Check if dates are in ascending order
                  for (let i = 1; i < dates.length; i++) {
                    expect(dates[i].getTime()).to.be.at.least(
                      dates[i - 1].getTime(),
                    );
                  }
                });
              }
            },
          );
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
  },
);
