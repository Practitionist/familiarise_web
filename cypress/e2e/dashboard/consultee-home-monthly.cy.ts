/// <reference types="cypress" />
import { setupConsulteeDashboard } from "./consultee-setup.cy";
import consulteeIdsFixture from "../../fixtures/consultee-ids.json";

interface ConsulteeIdsFixture {
  consulteeIds: string[];
}

(consulteeIdsFixture as unknown as ConsulteeIdsFixture).consulteeIds.forEach((consulteeId) => {
  describe(`Consultee Dashboard - Home Tab Monthly View (ID: ${consulteeId})`, () => {
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
      "displays correct monthly events",
      { defaultCommandTimeout: 30000 },
      () => {
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "test_start",
            test: "displays correct monthly events",
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

          // Log the events for debugging
          cy.readFile("cypress/logs/info.json").then((logs) => {
            logs.push({
              timestamp: new Date().toISOString(),
              type: "debug",
              message: "Checking tentative schedules",
              data: {
                consultations: consultations.map((c: any) => ({
                  id: c.id,
                  hasTentative: !!c.preferredDateTime,
                })),
                subscriptions: subscriptions.map((s: any) => ({
                  id: s.id,
                  hasTentative: !!s.tentativeSchedule,
                })),
                webinars: webinars.map((w: any) => ({
                  id: w.id,
                  hasTentative: !!w.scheduledAt,
                })),
                classes: classes.map((c: any) => ({
                  id: c.id,
                  hasTentative: !!c.tentativeSchedule,
                })),
              },
            });
            cy.writeFile("cypress/logs/info.json", logs);
          });

            // Verify monthly slots format
            cy.get('[data-testid="monthly-slot"]').each(($slot) => {
              cy.wrap($slot)
                .invoke("text")
                .then((text) => {
                  // Verify date format (e.g., "Tue, 31 Dec 2024")
                  expect(text).to.match(
                    /(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Za-z]{3} \d{4}/,
                  );
                  // Verify time format (e.g., "1:00 pm - 2:00 pm")
                  expect(text).to.match(
                    /\d{1,2}:\d{2} [ap]m - \d{1,2}:\d{2} [ap]m/,
                  );
                });
            });

          // Check for tentative events
          const hasTentativeEvents =
            consultations.some((c: any) => c.preferredDateTime) ||
            subscriptions.some((s: any) => s.tentativeSchedule) ||
            webinars.some((w: any) => w.scheduledAt) ||
            classes.some((c: any) => c.tentativeSchedule);

            if (hasTentativeEvents) {
              // Log that we found tentative events
              cy.readFile("cypress/logs/info.json").then((logs) => {
                logs.push({
                  timestamp: new Date().toISOString(),
                  type: "debug",
                  message: "Found tentative events, checking for notice",
                });
                cy.writeFile("cypress/logs/info.json", logs);
              });

              // Check for tentative notice in either upcoming or monthly sections
              cy.get('[data-testid="tentative-notice"]')
                .should("exist")
                .first()
                .should("contain", "*Subject to change");
            }
          },
        );
      },
    );

    it(
      "allows navigation between months and years",
      { defaultCommandTimeout: 30000 },
      () => {
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "test_start",
            test: "allows navigation between months",
          });
          cy.writeFile("cypress/logs/info.json", logs);
        });

        // Get current month/year text
        cy.get('[data-testid="month-nav"]')
          .find("h2")
          .invoke("text")
          .then((currentMonthYear) => {
            const [currentMonth, currentYear] = currentMonthYear.split(" ");

            // Navigate to next year
            for (let i = 0; i < 12; i++) {
              cy.get('[data-testid="next-month"]').click();
            }
            // Verify year changed
            cy.get('[data-testid="month-nav"]')
              .find("h2")
              .should("contain", `${currentMonth} ${parseInt(currentYear) + 1}`);

            // Navigate back to current month/year
            for (let i = 0; i < 12; i++) {
              cy.get('[data-testid="prev-month"]').click();
            }
            // Verify back to original month/year
            cy.get('[data-testid="month-nav"]')
              .find("h2")
              .should("contain", `${currentMonth} ${currentYear}`);

            // Verify events are sorted by date within the month
            cy.get('[data-testid="monthly-slot"]').then(($slots) => {
              const dates = $slots
                .map((_, el) => {
                  const text = Cypress.$(el).text();
                  const match = text.match(/[A-Za-z]{3}, \d{1,2} [A-Za-z]{3} \d{4}/);
                  if (!match) {
                    throw new Error(`Invalid date format in text: ${text}`);
                  }
                  return new Date(match[0]);
                })
                .get();
              
              // Check if dates are in ascending order
              for (let i = 1; i < dates.length; i++) {
                expect(dates[i].getTime()).to.be.at.least(dates[i-1].getTime());
              }
            });
          });
      },
    );
  });
});
