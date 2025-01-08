import { setupConsulteeDashboard } from "./consultee-setup.cy";
import consulteeIdsFixture from "../../../fixtures/consultee-ids.json";

interface ConsulteeIdsFixture {
  consulteeIds: string[];
}

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

(consulteeIdsFixture as unknown as ConsulteeIdsFixture).consulteeIds.forEach(
  (consulteeId) => {
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
          // Get all slots from API
          const allSlots = interceptions.flatMap((interception) => {
            const events = interception.response?.body?.data || [];
            return getAllSlots(events);
          });

          // First filter by previous year (matching getActualSlots)
          const now = new Date();
          const previousYear = now.getFullYear() - 1;
          const validSlots = allSlots.filter((slot) => {
            const slotDate = new Date(slot.slotStartTimeInUTC);
            return slotDate.getFullYear() > previousYear;
          });

          // Then filter future slots (matching getActualUpcomingSlots)
          const futureSlots = validSlots
            .filter((slot) => new Date(slot.slotStartTimeInUTC) > now)
            .sort(
              (a, b) =>
                new Date(a.slotStartTimeInUTC).getTime() -
                new Date(b.slotStartTimeInUTC).getTime(),
            );

          // Verify upcoming section
          cy.get('[data-testid="upcoming-slot-list"]')
            .find(
              '[data-testid^="webinar-"], [data-testid^="class-"], [data-testid^="consultation-"], [data-testid^="subscription-"]',
            )
            .should("have.length", futureSlots.length);

          // Test navigation if there are slots
          if (futureSlots.length > 0) {
            // Click next a few times
            for (let i = 0; i < 3; i++) {
              cy.get('[data-testid="next-upcoming"]').click();
              cy.wait(200);
            }
            // Click previous to go back
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
          // Get all slots from API
          const allSlots = interceptions.flatMap((interception) => {
            const events = interception.response?.body?.data || [];
            return getAllSlots(events);
          });

          // Filter slots by previous year (matching getActualSlots)
          const now = new Date();
          const previousYear = now.getFullYear() - 1;
          const validSlots = allSlots.filter((slot) => {
            const slotDate = new Date(slot.slotStartTimeInUTC);
            return slotDate.getFullYear() > previousYear;
          });

          // Group by month
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

          // Get sorted months
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
            // Navigate to each month and verify slots
            months.forEach(({ date, slots }) => {
              const monthString = getMonthYearString(date);

              // Navigate to correct month
              cy.get('[data-testid="monthly-slot-list"]', { timeout: 10000 })
                .parent()
                .find("h2")
                .then(($header) => {
                  const currentMonth = $header.text();

                  // If not on target month, navigate to it
                  if (currentMonth !== monthString) {
                    // Function to navigate one step
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

                    // Try navigation up to 3 times
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

              // Verify slots for this month
              cy.get('[data-testid="monthly-slot"]', { timeout: 10000 }).should(
                "have.length",
                slots.length,
              );
            });
          }
        });
      });
    });
  },
);
