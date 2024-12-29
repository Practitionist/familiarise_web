/// <reference types="cypress" />

// Function to get all consultee IDs from database
// export function getConsulteeIds() {
//   return cy.request('/api/user/consultees').then((response) => {
//     expect(response.status).to.equal(200);
//     const consultees = response.body;
//     expect(consultees).to.be.an('array');
//     expect(consultees.length).to.be.greaterThan(0);
//     return consultees.map(c => c.id);
//   });
// }

export const consulteeIds = [
  '73318747-3425-4bb6-bba7-c3d6a6798441', // Original ID
  "15328195-84ef-47a2-b142-3ea4749c52f6",
  "1ab7e4e2-fe2a-4c71-904d-d39e63e38278"
];

// Shared setup function
export function setupConsulteeDashboard(consulteeId: string) {
  // Create logs directory and initialize info.json if needed
  cy.exec('mkdir -p cypress/logs');
  cy.writeFile('cypress/logs/info.json', [], { flag: 'w' });

  // Intercept API calls
  cy.intercept('GET', `/api/events/consultations?consulteeProfileId=${consulteeId}`).as('getConsultations');
  cy.intercept('GET', `/api/events/subscriptions?consulteeProfileId=${consulteeId}`).as('getSubscriptions');
  cy.intercept('GET', `/api/events/classes?consulteeProfileId=${consulteeId}`).as('getClasses');
  cy.intercept('GET', `/api/events/webinars?consulteeProfileId=${consulteeId}`).as('getWebinars');

  // Visit the consultee dashboard
  cy.visit(`/dashboard/consultee/${consulteeId}`);

  // Wait for API calls to complete and content to load
  cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses', '@getWebinars'], { timeout: 30000 }).then((interceptions) => {
    // Log all API responses for debugging
    interceptions.forEach((interception: any) => {
      cy.log(`${interception.request.url} Response:`, JSON.stringify(interception.response?.body, null, 2));
      
      // Log API response info
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'api_response',
          endpoint: interception.request.url,
          status: interception.response?.statusCode,
          data: interception.response?.body
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      if (interception.response?.statusCode >= 400) {
        cy.writeFile('cypress/logs/api-errors.json', {
          timestamp: new Date().toISOString(),
          endpoint: interception.request.url,
          status: interception.response.statusCode,
          error: interception.response.body
        }, { flag: 'a+' });
      }
    });
  });

  // Wait for slot list to be visible and log it
  cy.get('[data-testid="slot-list"]', { timeout: 30000 }).should('exist').then(() => {
    cy.readFile('cypress/logs/info.json').then((logs) => {
      logs.push({
        timestamp: new Date().toISOString(),
        type: 'ui_state',
        message: 'Slot list element found'
      });
      cy.writeFile('cypress/logs/info.json', logs);
    });
  });

  // Verify loading state is gone and log it
  cy.contains('Loading user data...', { timeout: 30000 }).should('not.exist').then(() => {
    cy.readFile('cypress/logs/info.json').then((logs) => {
      logs.push({
        timestamp: new Date().toISOString(),
        type: 'ui_state',
        message: 'Loading state removed'
      });
      cy.writeFile('cypress/logs/info.json', logs);
    });
  });
}

// Helper function to format date time
export function formatDateTime(start: Date, end?: Date): string {
  const weekday = start.toLocaleString('en-US', { weekday: 'short' });
  const day = start.getDate();
  const month = start.toLocaleString('en-US', { month: 'short' });
  const year = start.getFullYear();

  function formatTimeString(d: Date): string {
    let hours = d.getHours();
    const minutes = d.getMinutes();
    const ampm = hours >= 12 ? 'pm' : 'am';
    
    // Convert hours to 12-hour format
    if (hours === 0) hours = 12;  // Convert 0:00 to 12:00 AM
    else if (hours > 12) hours -= 12;
    
    return `${hours}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  }

  const timeStr = end
    ? `${formatTimeString(start)} - ${formatTimeString(end)}`
    : formatTimeString(start);

  return `${weekday}, ${day} ${month} ${year}, ${timeStr}`;
}
