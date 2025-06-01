/// <reference types="cypress" />
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

// Helper function to find a valid consultee ID by checking against the API
function findValidConsulteeId(
  consultees: any[],
  index = 0,
): Cypress.Chainable<string> {
  if (index >= consultees.length) {
    // After checking all candidates, if none are valid, throw an error.
    // This will fail the test run, indicating a problem with test data.
    return cy.then(() => {
      throw new Error(
        "No valid consultee ID found after checking all candidates from /api/user/consultees. Test data may be inconsistent.",
      );
    });
  }

  const consultee = consultees[index];
  // Ensure the consultee object and its user.id property exist
  if (consultee && consultee.user && consultee.user.id) {
    const potentialId = consultee.user.id;
    cy.log(
      `Attempting to validate consultee ID: ${potentialId} (index ${index})`,
    );
    return cy
      .request({
        method: "GET",
        url: `/api/user/${potentialId}`,
        failOnStatusCode: false, // Prevent Cypress from failing the test on a 404 for this specific request
      })
      .then((response) => {
        if (response.status === 200) {
          cy.log(
            `Successfully validated Consultee ID: ${potentialId} at index ${index}.`,
          );
          return potentialId; // ID is valid, return it
        } else {
          cy.log(
            `Consultee ID ${potentialId} (index ${index}) is invalid (API returned status: ${response.status}). Trying next.`,
          );
          return findValidConsulteeId(consultees, index + 1); // Try the next consultee
        }
      });
  } else {
    // If the consultee object is malformed or missing user.id, skip it and try the next one.
    cy.log(
      `Consultee data at index ${index} is malformed or missing user.id. Trying next.`,
    );
    return findValidConsulteeId(consultees, index + 1);
  }
}

function getMonthYearString(date: Date): string {
  return date.toLocaleString("default", { month: "long", year: "numeric" });
}

describe("Consultee Home Page with Dynamic ID", () => {
  let dynamicConsulteeId: string;

  // Helper function to click next/prev month and wait
  function navigateOneStep(direction: "next" | "prev"): void {
    cy.get(`[data-testid="${direction}-month"]`).click();
    cy.wait(500); // Wait for potential UI updates
  }

  // "Private" recursive helper for navigateCalendarToMonth
  function _attemptCalendarNavigation(
    targetMonthString: string,
    targetDate: Date,
    maxAttempts: number,
    currentAttempt: number,
  ): Cypress.Chainable<null> {
    if (currentAttempt > maxAttempts) {
      throw new Error(
        `Failed to navigate to ${targetMonthString} after ${maxAttempts} attempts.`,
      );
    }
    return cy
      .get('[data-testid="monthly-slot-list"]')
      .parent()
      .find("h2")
      .invoke("text")
      .then((currentDisplayedMonth) => {
        if (currentDisplayedMonth.trim() === targetMonthString) {
          return cy.wrap(null);
        }

        const currentParts = currentDisplayedMonth.trim().split(" ");
        const currentMonthName = currentParts[0];
        const currentYear = parseInt(currentParts[1], 10);

        const monthMap: { [key: string]: number } = {
          January: 0,
          February: 1,
          March: 2,
          April: 3,
          May: 4,
          June: 5,
          July: 6,
          August: 7,
          September: 8,
          October: 9,
          November: 10,
          December: 11,
        };
        const currentMonthIndex = monthMap[currentMonthName];

        const targetMonthIndex = targetDate.getMonth();
        const targetYear = targetDate.getFullYear();

        if (
          currentYear < targetYear ||
          (currentYear === targetYear && currentMonthIndex < targetMonthIndex)
        ) {
          navigateOneStep("next");
        } else if (
          currentYear > targetYear ||
          (currentYear === targetYear && currentMonthIndex > targetMonthIndex)
        ) {
          navigateOneStep("prev");
        } else {
          // This case implies current month/year are same as target, but string didn't match.
          // This could happen with subtle formatting differences or if targetMonthString is invalid.
          // To prevent infinite loops, we'll try 'prev' as a default action if not strictly less.
          // Ideally, this state indicates an issue with targetMonthString or month display consistency.
          navigateOneStep("prev");
        }
        return _attemptCalendarNavigation(
          targetMonthString,
          targetDate,
          maxAttempts,
          currentAttempt + 1,
        );
      });
  }

  // Helper function to navigate calendar to a target month string
  function navigateCalendarToMonth(
    targetMonthString: string,
    targetDate: Date,
    maxAttempts = 12,
  ): Cypress.Chainable<null> {
    return _attemptCalendarNavigation(
      targetMonthString,
      targetDate,
      maxAttempts,
      1,
    ); // Initial call
  }

  // Recursive helper to process months sequentially for the monthly view test
  function processSingleMonthRecursively(
    index: number,
    allMonths: { date: Date; slots: Slot[] }[],
  ): Cypress.Chainable<null> {
    if (index >= allMonths.length) {
      return cy.wrap(null); // All months processed
    }

    const { date, slots } = allMonths[index];
    const monthString = getMonthYearString(date);

    return cy
      .get('[data-testid="monthly-slot-list"]', { timeout: 10000 })
      .parent()
      .find("h2")
      .invoke("text")
      .then((currentMonthText) => {
        if (currentMonthText.trim() !== monthString) {
          return navigateCalendarToMonth(monthString, date);
        }
        return cy.wrap(null); // Continue chain if no navigation needed
      })
      .then(() => {
        // This block executes after navigation (if any) is complete
        cy.get('[data-testid="monthly-slot-list"]')
          .find(
            '[data-testid^="webinar-"], [data-testid^="class-"], [data-testid^="consultation-"], [data-testid^="subscription-"]',
          )
          .should("have.length", slots.length);

        // Recursively call for the next month
        return processSingleMonthRecursively(index + 1, allMonths);
      });
  }

  before(() => {
    cy.request("GET", "/api/user/consultees?limit=5") // Fetch top 5 potential consultees
      .its("body")
      .then((consultees: any[]) => {
        if (!consultees || consultees.length === 0) {
          // This will fail the test run if no consultees are returned at all.
          throw new Error(
            "No consultees found from API /api/user/consultees. Cannot proceed with tests.",
          );
        }
        // Attempt to find a valid consultee ID from the fetched list
        return findValidConsulteeId(consultees);
      })
      .then((validId) => {
        // This .then() executes only if findValidConsulteeId successfully returns an ID.
        // If findValidConsulteeId throws an error (e.g., no valid ID found), this block will not be reached,
        // and the test setup will fail, which is the desired behavior.
        dynamicConsulteeId = validId;
        // dynamicConsulteeId is now set with a validated ID and can be used in beforeEach and tests.
        cy.log(
          `Using validated Consultee ID for Home Page tests: ${dynamicConsulteeId}`,
        );
      });
  });

  beforeEach(() => {
    if (!dynamicConsulteeId) {
      throw new Error(
        "Consultee ID was not available for beforeEach setup in Home Page tests.",
      );
    }
    setupConsulteeDashboard(dynamicConsulteeId, "home");
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
        processSingleMonthRecursively(0, months);
      }
    });
  });
});
