/// <reference types="cypress" />


// Shared setup function
export function setupConsulteeDashboard(consulteeId: string, route?: string) {
  // Create logs directory and initialize info.json if needed
  cy.exec("mkdir -p cypress/logs");
  cy.writeFile("cypress/logs/info.json", [], { flag: "w" });

  // Intercept API calls
  cy.intercept(
    "GET",
    `/api/events/consultations?consulteeProfileId=${consulteeId}`,
  ).as("getConsultations");
  cy.intercept(
    "GET",
    `/api/events/subscriptions?consulteeProfileId=${consulteeId}`,
  ).as("getSubscriptions");
  cy.intercept(
    "GET",
    `/api/events/classes?consulteeProfileId=${consulteeId}`,
  ).as("getClasses");
  cy.intercept(
    "GET",
    `/api/events/webinars?consulteeProfileId=${consulteeId}`,
  ).as("getWebinars");

  // Visit the appropriate route
  const baseUrl = `/dashboard/consultee/${consulteeId}`;
  cy.visit(route ? `${baseUrl}/${route}` : `${baseUrl}/home`);

  // Wait for each API call individually
  cy.wait("@getConsultations", { timeout: 30000 }).then((interception: any) => {
    logApiResponse(interception);
  });
  cy.wait("@getSubscriptions", { timeout: 30000 }).then((interception: any) => {
    logApiResponse(interception);
  });
  cy.wait("@getClasses", { timeout: 30000 }).then((interception: any) => {
    logApiResponse(interception);
  });
  cy.wait("@getWebinars", { timeout: 30000 }).then((interception: any) => {
    logApiResponse(interception);
  });

  // Handle different routes
  if (!route || route === "home") {
    // Wait for home page specific elements
    cy.get('[data-testid="upcoming-slot-list"]', { timeout: 30000 }).should(
      "exist",
    );
    cy.get('[data-testid="monthly-slot-list"]', { timeout: 30000 }).should(
      "exist",
    );
  } else if (route === "appointments") {
    // Wait for appointments page specific elements
    cy.get('[data-testid="overview-grid"]', { timeout: 30000 }).should("exist");
  }

  // Log UI state
  cy.readFile("cypress/logs/info.json").then((logs) => {
    logs.push({
      timestamp: new Date().toISOString(),
      type: "ui_state",
      message: `Page loaded: ${route || "home"}`,
      route: route || "home",
    });
    cy.writeFile("cypress/logs/info.json", logs);
  });

  // Verify loading state is gone
  cy.contains("Loading", { timeout: 30000 })
    .should("not.exist")
    .then(() => {
      cy.readFile("cypress/logs/info.json").then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: "ui_state",
          message: "Loading state removed",
        });
        cy.writeFile("cypress/logs/info.json", logs);
      });
    });
}

function logApiResponse(interception: any) {
  cy.log(
    `${interception.request.url} Response:`,
    JSON.stringify(interception.response?.body, null, 2),
  );

  // Log API response info
  cy.readFile("cypress/logs/info.json").then((logs) => {
    logs.push({
      timestamp: new Date().toISOString(),
      type: "api_response",
      endpoint: interception.request.url,
      status: interception.response?.statusCode,
      data: interception.response?.body,
    });
    cy.writeFile("cypress/logs/info.json", logs);
  });

  if (interception.response?.statusCode >= 400) {
    cy.writeFile(
      "cypress/logs/api-errors.json",
      {
        timestamp: new Date().toISOString(),
        endpoint: interception.request.url,
        status: interception.response.statusCode,
        error: interception.response.body,
      },
      { flag: "a+" },
    );
  }
}

// Helper function to format date time
export function formatDateTime(start: Date, end?: Date): string {
  const weekday = start.toLocaleString("en-US", { weekday: "short" });
  const day = start.getDate();
  const month = start.toLocaleString("en-US", { month: "short" });
  const year = start.getFullYear();

  function formatTimeString(d: Date): string {
    let hours = d.getHours();
    const minutes = d.getMinutes();
    const ampm = hours >= 12 ? "pm" : "am";

    // Convert hours to 12-hour format
    if (hours === 0)
      hours = 12; // Convert 0:00 to 12:00 AM
    else if (hours > 12) hours -= 12;

    return `${hours}:${minutes.toString().padStart(2, "0")} ${ampm}`;
  }

  const timeStr = end
    ? `${formatTimeString(start)} - ${formatTimeString(end)}`
    : formatTimeString(start);

  return `${weekday}, ${day} ${month} ${year}, ${timeStr}`;
}
