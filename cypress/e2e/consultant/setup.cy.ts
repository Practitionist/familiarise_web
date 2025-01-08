/// <reference types="cypress" />

export const consultantIds = [
  "1134f48f-a2ac-4dd0-bbbb-29f02a327558", // From the URL in the screenshot
];

export function setupConsultantAppointments(consultantId: string) {
  // Intercept API calls
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

  // Visit appointments page
  cy.visit(`/dashboard/consultant/${consultantId}/appointments`);

  // Wait for all API calls to complete
  cy.wait(["@getConsultations", "@getSubscriptions", "@getClasses", "@getWebinars"]);
}
