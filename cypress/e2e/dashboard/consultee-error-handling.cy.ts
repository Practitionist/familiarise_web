/// <reference types="cypress" />
import { consulteeIds } from "./consultee-setup.cy";

consulteeIds.forEach((consulteeId) => {
  describe(`Consultee Dashboard - Error Handling (ID: ${consulteeId})`, () => {
    beforeEach(() => {
      // Create logs directory and initialize info.json if needed
      cy.exec("mkdir -p cypress/logs");
      cy.writeFile("cypress/logs/info.json", [], { flag: "w" });
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
      "handles API errors gracefully",
      { defaultCommandTimeout: 30000 },
      () => {
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "test_start",
            test: "handles API errors gracefully",
          });
          cy.writeFile("cypress/logs/info.json", logs);
        });

        // Test error handling for each API endpoint
        ["Consultations", "Subscriptions", "Classes", "Webinars"].forEach(
          (eventType) => {
            cy.intercept(
              "GET",
              `/api/events/${eventType.toLowerCase()}?consulteeProfileId=${consulteeId}`,
              {
                statusCode: 500,
                body: { error: `Failed to fetch ${eventType}` },
              },
            ).as(`get${eventType}Error`);

            cy.visit(`/dashboard/consultee/${consulteeId}`);
            cy.get(".bg-red-50").should("contain", "Error loading events");
          },
        );
      },
    );
  });
});
