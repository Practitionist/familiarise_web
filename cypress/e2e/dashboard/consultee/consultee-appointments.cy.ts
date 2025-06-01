/// <reference types="cypress" />
import { setupConsulteeDashboard } from "./consultee-setup.cy";

type EventType = "Consultation" | "Subscription" | "Class" | "Webinar";

interface Slot {
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
  isTentative: boolean;
  event: {
    id: string;
    type?: EventType;
    status?: string;
    requestStatus?: string;
    consultationPlan?: {
      title: string;
      consultantProfile?: {
        user?: {
          name: string;
        };
      };
    };
    subscriptionPlan?: {
      title: string;
      consultantProfile?: {
        user?: {
          name: string;
        };
      };
    };
    webinarPlan?: {
      title: string;
      consultantProfile?: {
        user?: {
          name: string;
        };
      };
    };
    classPlan?: {
      title: string;
      consultantProfile?: {
        user?: {
          name: string;
        };
      };
    };
  };
}

function getAllSlots(events: any[]): Slot[] {
  return events.flatMap((event) => {
    const slots =
      event.appointment?.slotsOfAppointment ||
      event.appointments?.flatMap((apt: any) => apt.slotsOfAppointment) ||
      [];
    return slots.map((slot: any) => ({
      ...slot,
      event,
    }));
  });
}

function getEventType(event: Slot["event"]): EventType {
  if (event.consultationPlan) return "Consultation";
  if (event.subscriptionPlan) return "Subscription";
  if (event.classPlan) return "Class";
  if (event.webinarPlan) return "Webinar";
  throw new Error(`Unknown event type for event: ${event.id}`);
}

// Helper function to find a valid consultee ID by checking against the API
function findValidConsulteeId(consultees: any[], index = 0): Cypress.Chainable<string> {
  if (index >= consultees.length) {
    // After checking all candidates, if none are valid, throw an error.
    // This will fail the test run, indicating a problem with test data.
    return cy.then(() => {
      throw new Error('No valid consultee ID found after checking all candidates from /api/user/consultees. Test data may be inconsistent.');
    });
  }

  const consultee = consultees[index];
  // Ensure the consultee object and its user.id property exist
  if (consultee && consultee.user && consultee.user.id) {
    const potentialId = consultee.user.id;
    cy.log(`Attempting to validate consultee ID: ${potentialId} (index ${index})`);
    return cy.request({
      method: 'GET',
      url: `/api/user/${potentialId}`,
      failOnStatusCode: false // Prevent Cypress from failing the test on a 404 for this specific request
    }).then(response => {
      if (response.status === 200) {
        cy.log(`Successfully validated Consultee ID: ${potentialId} at index ${index}.`);
        return potentialId; // ID is valid, return it
      } else {
        cy.log(`Consultee ID ${potentialId} (index ${index}) is invalid (API returned status: ${response.status}). Trying next.`);
        return findValidConsulteeId(consultees, index + 1); // Try the next consultee
      }
    });
  } else {
    // If the consultee object is malformed or missing user.id, skip it and try the next one.
    cy.log(`Consultee data at index ${index} is malformed or missing user.id. Trying next.`);
    return findValidConsulteeId(consultees, index + 1);
  }
}

function formatTimeForOverview(date: Date): string {
  // Format time to match Overview format: "h:mm am/pm" (no leading zero for hour, lowercase am/pm)
  const hour = date.getHours() % 12 || 12;
  const minute = date.getMinutes().toString().padStart(2, "0");
  const period = date.getHours() < 12 ? "am" : "pm";
  return `${hour}:${minute} ${period}`;
}

describe('Consultee Appointments Page with Dynamic ID', () => {
  let dynamicConsulteeId: string;

  before(() => {
    cy.request('GET', '/api/user/consultees?limit=5') // Fetch top 5 potential consultees
      .its('body')
      .then((consultees: any[]) => {
        if (!consultees || consultees.length === 0) {
          // This will fail the test run if no consultees are returned at all.
          throw new Error('No consultees found from API /api/user/consultees. Cannot proceed with tests.');
        }
        // Attempt to find a valid consultee ID from the fetched list
        return findValidConsulteeId(consultees);
      })
      .then(validId => {
        // This .then() executes only if findValidConsulteeId successfully returns an ID.
        // If findValidConsulteeId throws an error (e.g., no valid ID found), this block will not be reached,
        // and the test setup will fail, which is the desired behavior.
        dynamicConsulteeId = validId;
        // dynamicConsulteeId is now set with a validated ID and can be used in beforeEach and tests.
        cy.log(`Using validated Consultee ID for tests: ${dynamicConsulteeId}`);
      });
  });

  beforeEach(() => {
    if (!dynamicConsulteeId) {
        throw new Error("Consultee ID was not available for beforeEach setup.");
    }
    cy.exec("mkdir -p cypress/logs");
    cy.writeFile("cypress/logs/info.json", []);
    setupConsulteeDashboard(dynamicConsulteeId, "appointments");
  });

  it("verifies overview section shows all appointments", () => {
    // Wait for overview grid to load
    cy.get('[data-testid="overview-grid"]').should("be.visible");

    // First verify all section cards exist
    ["consultations", "subscriptions", "classes", "webinars"].forEach(
      (type) => {
        cy.get(`[data-testid="${type}-card"]`).should("exist");
      },
    );

    // Get all slots from API responses
    cy.get("@getConsultations").then((consultationsReq: any) => {
      const consultations = consultationsReq.response?.body?.data || [];
      cy.get("@getSubscriptions").then((subscriptionsReq: any) => {
        const subscriptions = subscriptionsReq.response?.body?.data || [];
        cy.get("@getClasses").then((classesReq: any) => {
          const classes = classesReq.response?.body?.data || [];
          cy.get("@getWebinars").then((webinarsReq: any) => {
            const webinars = webinarsReq.response?.body?.data || [];

            // Process all slots
            const allEvents = [
              ...consultations,
              ...subscriptions,
              ...classes,
              ...webinars,
            ];
            const allSlots = getAllSlots(allEvents);

            // Log total slots for debugging
            cy.writeFile("cypress/logs/info.json", [
              {
                timestamp: new Date().toISOString(),
                type: "total_slots",
                count: allSlots.length,
                consulteeId: dynamicConsulteeId, 
              },
            ]);

            // Group slots by event type
            const slotsByType = allSlots.reduce(
              (acc, slot) => {
                const type = getEventType(slot.event).toLowerCase();
                if (!acc[type]) acc[type] = [];
                acc[type].push(slot);
                return acc;
              },
              {} as Record<string, Slot[]>,
            );

            // Log slot counts by type
            cy.writeFile("cypress/logs/info.json", [
              {
                timestamp: new Date().toISOString(),
                type: "slots_by_type",
                counts: Object.fromEntries(
                  Object.entries(slotsByType).map(([type, slots]) => [
                    type,
                    slots.length,
                  ]),
                ),
                consulteeId: dynamicConsulteeId, 
              },
            ]);

            // Then verify slots for types that have them
            Object.entries(slotsByType).forEach(([type, slots]) => {
              if (slots.length > 0) {
                const cardSelector = `[data-testid="${type}s-card"]`;

                // For subscriptions and classes, expand the schedule first
                if (type === "subscription" || type === "class") {
                  // First verify the section card exists
                  cy.get(cardSelector).should("be.visible");

                  // Get all events of this type
                  const events =
                    type === "subscription" ? subscriptions : classes;

                  // For each event that has slots
                  events.forEach((event) => {
                    const eventSlots = slots.filter(
                      (slot) => slot.event.id === event.id,
                    );
                    if (eventSlots.length > 0) {
                      // Find and expand this event's card
                      cy.get(`[data-testid="${type}-${event.id}"]`).within(
                        () => {
                          // Click on accordion trigger and wait for expansion
                          cy.contains(
                            type === "subscription"
                              ? "Scheduled Sessions"
                              : "Class Schedule",
                          ).click();

                          // Wait for slot list to be visible
                          cy.get('[data-testid="slot-list"]').should(
                            "be.visible",
                          );

                          // Verify each slot in the list
                          eventSlots.forEach((slotData) => {
                            const startTime = new Date(
                              slotData.slotStartTimeInUTC,
                            );
                            const endTime = new Date(
                              slotData.slotEndTimeInUTC,
                            );
                            const expectedTimeRange = `${formatTimeForOverview(
                              startTime,
                            )} - ${formatTimeForOverview(endTime)}`;

                            cy.contains(expectedTimeRange).should(
                              "be.visible",
                            );
                          });
                        },
                      );
                    }
                  });
                } else {
                  cy.get(cardSelector)
                    .find('[data-testid^="slot-item-"]')
                    .should("have.length", slots.length);
                  slots.forEach((slotData) => {
                    const startTime = new Date(slotData.slotStartTimeInUTC);
                    const endTime = new Date(slotData.slotEndTimeInUTC);
                    const expectedTimeRange = `${formatTimeForOverview(
                      startTime,
                    )} - ${formatTimeForOverview(endTime)}`;
                    cy.get(cardSelector)
                      .contains(expectedTimeRange)
                      .should("be.visible");
                  });
                }
              }
            });
          });
        });
      });
    });
  });

  it("verifies calendar section shows all appointments", () => {
    // Wait for calendar to load
    cy.get(".rbc-calendar").should("be.visible");

    cy.get("@getConsultations").then((consultationsReq: any) => {
      const consultations = consultationsReq.response?.body?.data || [];
      cy.get("@getSubscriptions").then((subscriptionsReq: any) => {
        const subscriptions = subscriptionsReq.response?.body?.data || [];
        cy.get("@getClasses").then((classesReq: any) => {
          const classes = classesReq.response?.body?.data || [];
          cy.get("@getWebinars").then((webinarsReq: any) => {
            const webinars = webinarsReq.response?.body?.data || [];

            const allEvents = [
              ...consultations,
              ...subscriptions,
              ...classes,
              ...webinars,
            ];
            const allSlots = getAllSlots(allEvents);

            const slotsByMonth = allSlots.reduce(
              (acc, slot) => {
                const monthKey = new Date(slot.slotStartTimeInUTC)
                  .toISOString()
                  .slice(0, 7); // YYYY-MM
                if (!acc[monthKey]) acc[monthKey] = [];
                acc[monthKey].push(slot);
                return acc;
              },
              {} as Record<string, Slot[]>,
            );

            function verifyMonth(targetDate?: Date) {
              if (targetDate) {
                // Navigation logic might be needed here for a full test
              }
              const currentCalendarDateStr = new Date()
                .toISOString()
                .slice(0, 7);
              const currentMonthSlots =
                slotsByMonth[currentCalendarDateStr] || [];

              currentMonthSlots.forEach((slotData) => {
                let title = "Unknown Event";

                if (slotData.event.consultationPlan) {
                  title = slotData.event.consultationPlan.title;
                } else if (slotData.event.subscriptionPlan) {
                  title = slotData.event.subscriptionPlan.title;
                } else if (slotData.event.webinarPlan) {
                  title = slotData.event.webinarPlan.title;
                } else if (slotData.event.classPlan) {
                  title = slotData.event.classPlan.title;
                }

                cy.get(".rbc-event-content")
                  .contains(title)
                  .should("exist");
              });
            }
            verifyMonth();
          });
        });
      });
    });
  });
});
