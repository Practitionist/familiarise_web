/// <reference types="cypress" />

export function setupConsultantAppointments(consultantId: string) {
  // Set up intercepts before visiting page
  cy.intercept(
    "GET",
    `/api/events/consultations?consultantProfileId=${consultantId}`,
  ).as("getConsultations");
  cy.intercept(
    "GET",
    `/api/events/subscriptions?consultantProfileId=${consultantId}`,
  ).as("getSubscriptions");
  cy.intercept(
    "GET",
    `/api/events/classes?consultantProfileId=${consultantId}`,
  ).as("getClasses");
  cy.intercept(
    "GET",
    `/api/events/webinars?consultantProfileId=${consultantId}`,
  ).as("getWebinars");

  // Visit page and wait for it to be ready
  cy.visit(`/dashboard/consultant/${consultantId}/appointments`);

  // Wait for API responses first
  cy.wait(
    ["@getConsultations", "@getSubscriptions", "@getClasses", "@getWebinars"],
    { timeout: 30000 },
  );

  // Then check for either appointments, loading state, or empty state
  cy.get(
    '[data-testid="appointment-item"], [data-testid="loading"], :contains("No Appointments Found")',
    { timeout: 30000 },
  ).should("exist");
}
