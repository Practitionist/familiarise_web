/// <reference types="cypress" />

export function setupConsultantAppointments(consultantId: string) {
  // Set up intercept for the consolidated appointments endpoint
  cy.intercept(
    "GET",
    `/api/events/consultations?consultantProfileId=${consultantId}&status=APPROVED`,
  ).as("getConsultations");
  cy.intercept(
    "GET",
    `/api/events/subscriptions?consultantProfileId=${consultantId}&status=APPROVED`,
  ).as("getSubscriptions");
  cy.intercept(
    "GET",
    `/api/events/webinars?consultantProfileId=${consultantId}&status=APPROVED`,
  ).as("getWebinars");
  cy.intercept(
    "GET",
    `/api/events/classes?consultantProfileId=${consultantId}&status=APPROVED`,
  ).as("getClasses");

  // Visit page and wait for it to be ready
  cy.visit(`/dashboard/consultant/${consultantId}/appointments`);

  // Wait for the appointments API response
  cy.wait(
    ["@getConsultations", "@getSubscriptions", "@getWebinars", "@getClasses"],
    { timeout: 30000 },
  );

  // Then check for either appointments, loading state, or empty state
  cy.get(
    '[data-testid="appointment-item"], [data-testid="loading"], :contains("No Appointments Found")',
    { timeout: 30000 },
  ).should("exist");
}
