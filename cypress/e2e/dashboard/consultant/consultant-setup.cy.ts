/// <reference types="cypress" />

export const consultantIds = [
  "1134f48f-a2ac-4dd0-bbbb-29f02a327558", // From the URL in the screenshot
];

export function setupConsultantAppointments(consultantId: string) {
  // Set up intercepts before visiting page
  cy.intercept("GET", `/api/events/consultations?consultantProfileId=${consultantId}`).as("getConsultations");
  cy.intercept("GET", `/api/events/subscriptions?consultantProfileId=${consultantId}`).as("getSubscriptions");
  cy.intercept("GET", `/api/events/classes?consultantProfileId=${consultantId}`).as("getClasses");
  cy.intercept("GET", `/api/events/webinars?consultantProfileId=${consultantId}`).as("getWebinars");

  // Visit page and wait for it to be ready
  cy.visit(`/dashboard/consultant/${consultantId}/appointments`);
  
  // Wait for either appointments to load or empty state
  cy.get('[data-testid="appointment-item"], :contains("No Appointments Found")', { timeout: 10000 }).should('exist');
}
