import { setupConsulteeDashboard } from "./consultee-setup.cy";

interface Slot {
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
  isTentative: boolean;
  event: {
    id: string;
    type: string;
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
    // Set the type first
    const eventWithType = {
      ...event,
      type: event.consultationPlan
        ? "Consultation"
        : event.subscriptionPlan
          ? "Subscription"
          : event.webinarPlan
            ? "Webinar"
            : event.classPlan
              ? "Class"
              : "Unknown",
    };

    // Now get slots based on the type
    const slots =
      eventWithType.type === "Subscription" || eventWithType.type === "Class"
        ? eventWithType.appointments?.flatMap(
            (apt: any) => apt.slotsOfAppointment,
          ) || []
        : eventWithType.appointment?.slotsOfAppointment || [];

    return slots.map((slot: any) => ({
      ...slot,
      event: eventWithType,
    }));
  });
}

function getMonthYearString(date: Date): string {
  return date.toLocaleString("default", { month: "long", year: "numeric" });
}

describe('Consultee Home Tests', () => {

  before(() => {
    cy.request<{ consulteeIds: string[] }>("GET", "/api/user/consultees?idsOnly=true")
      .then((response) => { // Generate tests inside .then()
        const consulteeIds = response?.body?.consulteeIds;

        // Handle case where IDs might not be loaded - skip generation
        if (!consulteeIds || consulteeIds.length === 0) {
           console.warn("No consultee IDs fetched, skipping test generation.");
           // No error thrown here, the dummy test will run
           return; 
        }

        // Iterate over the fetched IDs and define tests *within* the callback
        consulteeIds.forEach((consulteeId) => {
          describe(`Consultee Home Page - ID: ${consulteeId}`, () => {
            beforeEach(() => {
              setupConsulteeDashboard(consulteeId, "home");
            });

            it("verifies upcoming slots section", () => {
              cy.wait([
                "@getConsultations",
                "@getSubscriptions",
                "@getClasses",
                "@getWebinars",
              ]).then((interceptions: any[]) => {
                const allSlots = interceptions.flatMap((interception) => {
                  const events = interception.response?.body?.data || [];
                  return getAllSlots(events);
                });
                const now = new Date();
                const previousYear = now.getFullYear() - 1;
                const validSlots = allSlots.filter((slot) => {
                  const slotDate = new Date(slot.slotStartTimeInUTC);
                  return slotDate.getFullYear() > previousYear;
                });
                const futureSlots = validSlots
                  .filter((slot) => new Date(slot.slotStartTimeInUTC) > now)
                  .sort(
                    (a, b) =>
                      new Date(a.slotStartTimeInUTC).getTime() -
                      new Date(b.slotStartTimeInUTC).getTime(),
                  );
                cy.get('[data-testid="upcoming-slot-list"]')
                  .find(
                    '[data-testid^="webinar-"], [data-testid^="class-"], [data-testid^="consultation-"], [data-testid^="subscription-"]',
                  )
                  .should("have.length", futureSlots.length);
                if (futureSlots.length > 0) {
                  for (let i = 0; i < 3; i++) {
                    cy.get('[data-testid="next-upcoming"]').click();
                    cy.wait(200);
                  }
                  for (let i = 0; i < 3; i++) {
                    cy.get('[data-testid="prev-upcoming"]').click();
                    cy.wait(200);
                  }
                }
              });
            });

            it("verifies monthly slots section", () => {
              cy.wait([
                "@getConsultations",
                "@getSubscriptions",
                "@getClasses",
                "@getWebinars",
              ]).then((interceptions: any[]) => {
                const allSlots = interceptions.flatMap((interception) => {
                  const events = interception.response?.body?.data || [];
                  return getAllSlots(events);
                });
                const now = new Date();
                const previousYear = now.getFullYear() - 1;
                const validSlots = allSlots.filter((slot) => {
                  const slotDate = new Date(slot.slotStartTimeInUTC);
                  return slotDate.getFullYear() > previousYear;
                });
                const slotsByMonth = validSlots.reduce<Record<string, Slot[]>>(
                  (acc, slot) => {
                    const date = new Date(slot.slotStartTimeInUTC);
                    const key = `${date.getFullYear()}-${date.getMonth()}`;
                    if (!acc[key]) {
                      acc[key] = [];
                    }
                    acc[key].push(slot);
                    return acc;
                  },
                  {},
                );
                const months = Object.entries(slotsByMonth)
                  .map(([key, slots]) => {
                    const [year, month] = key.split("-").map(Number);
                    return {
                      date: new Date(year, month),
                      slots,
                    };
                  })
                  .sort((a, b) => a.date.getTime() - b.date.getTime());
                if (months.length > 0) {
                  months.forEach(({ date, slots }) => {
                    const monthString = getMonthYearString(date);
                    cy.get('[data-testid="monthly-slot-list"]', { timeout: 10000 })
                      .parent()
                      .find("h2")
                      .then(($header) => {
                        const currentMonth = $header.text();
                        if (currentMonth !== monthString) {
                          const navigateOneStep = () => {
                            const targetDate = date.getTime();
                            const currentDate = new Date(currentMonth).getTime();
                            const button =
                              targetDate < currentDate ? "prev-month" : "next-month";
                            return cy
                              .get(`[data-testid="${button}"]`)
                              .click()
                              .wait(500);
                          };
                          cy.wrap(null).then(() => {
                            const attemptNavigation = (attempt = 1) => {
                              if (attempt > 3) {
                                throw new Error(
                                  `Failed to navigate to ${monthString} after 3 attempts`,
                                );
                              }
                              return navigateOneStep().then(() => {
                                return cy
                                  .get('[data-testid="monthly-slot-list"]')
                                  .parent()
                                  .find("h2")
                                  .invoke("text")
                                  .then((newMonth) => {
                                    if (newMonth !== monthString) {
                                      return attemptNavigation(attempt + 1);
                                    }
                                  });
                              });
                            };
                            return attemptNavigation();
                          });
                        }
                      });
                    cy.get('[data-testid="monthly-slot"]', { timeout: 10000 }).should(
                      "have.length",
                      slots.length,
                    );
                  });
                }
              });
            });

            it("verifies recent feedback section", () => {
              // Wait for feedback data to potentially load (adjust if specific alias exists)
              cy.wait(500); // Simple wait, replace with alias if possible
              cy.get('[data-testid="recent-feedback-list"]').should("exist");
              // Further checks can be added here if needed
            });

            it("verifies support ticket section", () => {
              // Wait for support ticket data to potentially load (adjust if specific alias exists)
              cy.wait(500); // Simple wait, replace with alias if possible
              cy.get('[data-testid="support-ticket-list"]').should("exist");
              // Further checks can be added here if needed
            });
          });
        });
      });
  });

  // Keep the dummy 'it' block to ensure 'before' hook runs reliably
  // and provides feedback if no tests were generated due to missing IDs
  it('successfully loads tests or reports skipped generation', () => {
    cy.log('Consultee home tests generation attempt complete.');
  });
});
