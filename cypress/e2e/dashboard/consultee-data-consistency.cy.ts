/// <reference types="cypress" />
import { setupConsulteeDashboard } from "./consultee-setup.cy";
import consulteeIdsFixture from "../../fixtures/consultee-ids.json";
import { SlotOfAppointment } from "@prisma/client";
import { PREVIOUS_YEAR } from "../../../constants/datetime";

interface ConsulteeIdsFixture {
  consulteeIds: string[];
}

(consulteeIdsFixture as unknown as ConsulteeIdsFixture).consulteeIds.forEach(
  (consulteeId) => {
    describe(`Consultee Dashboard - Data Consistency (ID: ${consulteeId})`, () => {
      beforeEach(() => {
        setupConsulteeDashboard(consulteeId);
      });

      afterEach(function () {
        if (this.currentTest?.state === "failed") {
          cy.writeFile(
            "cypress/logs/errors.json",
            {
              timestamp: new Date().toISOString(),
              test: this.currentTest.title,
              error: this.currentTest.err?.message,
              stack: this.currentTest.err?.stack,
            },
            { flag: "a+" },
          );
        }
      });

      // Log uncaught exceptions
      Cypress.on("uncaught:exception", (err) => {
        cy.writeFile(
          "cypress/logs/uncaught-errors.json",
          {
            timestamp: new Date().toISOString(),
            error: err.message,
            stack: err.stack,
          },
          { flag: "a+" },
        );
        return false;
      });

      it(
        "verifies exact data consistency between API and UI",
        { defaultCommandTimeout: 30000 },
        () => {
          cy.readFile("cypress/logs/info.json").then((logs) => {
            logs.push({
              timestamp: new Date().toISOString(),
              type: "test_start",
              test: "verifies exact data consistency between API and UI",
            });
            cy.writeFile("cypress/logs/info.json", logs);
          });

          // Helper function to get slots for an event
          function getEventSlots(event: any) {
            // First try actual slots
            const appointments = Array.isArray(event.appointment)
              ? event.appointment
              : event.appointment
                ? [event.appointment]
                : [];

            const actualSlots = appointments
              .flatMap((apt: any) => apt?.slotsOfAppointment || [])
              .filter((slot: any) => {
                const year = new Date(slot.slotStartTimeInUTC).getFullYear();
                return year > PREVIOUS_YEAR;
              })
              .map((slot: any) => ({
                startTime: slot.slotStartTimeInUTC,
                endTime: slot.slotEndTimeInUTC,
                isTentative: false,
              }));

            // If we have actual slots, return those
            if (actualSlots.length > 0) {
              return actualSlots;
            }

            // Otherwise try tentative slots
            if (event.tentativeSchedule) {
              try {
                return JSON.parse(event.tentativeSchedule).map((slot: any) => ({
                  startTime: slot.startTime,
                  endTime: slot.endTime,
                  isTentative: true,
                }));
              } catch (e) {
                console.error("Error parsing tentative schedule:", e);
              }
            }

            return [];
          }

          // Helper function to format time
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

          // Helper function to check if date is in current month
          function isInCurrentMonth(date: Date): boolean {
            const now = new Date();
            return (
              date.getMonth() === now.getMonth() &&
              date.getFullYear() === now.getFullYear()
            );
          }

          // Wait for all API responses
          cy.wait([
            "@getConsultations",
            "@getSubscriptions",
            "@getWebinars",
            "@getClasses",
          ]).then(
            ([
              consultationsResp,
              subscriptionsResp,
              webinarsResp,
              classesResp,
            ]) => {
              const consultations = consultationsResp.response?.body.data || [];
              const subscriptions = subscriptionsResp.response?.body.data || [];
              const webinars = webinarsResp.response?.body.data || [];
              const classes = classesResp.response?.body.data || [];

              // Helper function to check if event has valid slots
              function hasValidSlots(event: any) {
                // Check for actual appointment slots
                const appointments = Array.isArray(event.appointment)
                  ? event.appointment
                  : event.appointment
                    ? [event.appointment]
                    : [];

                // We need to use some and not every because we dont want mixed cases to be filtered out
                const hasValidAppointments = appointments.some((apt) =>
                  apt?.slotsOfAppointment?.some((slot: SlotOfAppointment) => {
                    const year = new Date(
                      slot.slotStartTimeInUTC,
                    ).getFullYear();
                    return year > PREVIOUS_YEAR;
                  }),
                );

                if (hasValidAppointments) return true;

                // Check for valid tentative schedule
                if (event.tentativeSchedule) {
                  try {
                    const schedule = JSON.parse(event.tentativeSchedule);
                    return schedule.some((slot: any) => {
                      const date = new Date(slot.startTime);
                      return date.getFullYear() > PREVIOUS_YEAR;
                    });
                  } catch (e) {
                    return false;
                  }
                }

                // Check for preferred date time (consultations)
                if (event.preferredDateTime) {
                  const date = new Date(event.preferredDateTime);
                  return date.getFullYear() > PREVIOUS_YEAR;
                }

                // Check for scheduled time (webinars)
                if (event.scheduledAt) {
                  const date = new Date(event.scheduledAt);
                  return date.getFullYear() > PREVIOUS_YEAR;
                }

                return false;
              }

              // Filter events to only include those with valid slots
              const validConsultations = consultations.filter(hasValidSlots);
              const validSubscriptions = subscriptions.filter(hasValidSlots);
              const validWebinars = webinars.filter(hasValidSlots);
              const validClasses = classes.filter(hasValidSlots);

              // Verify all valid events are displayed in correct order
              const allValidEvents = [
                ...validConsultations,
                ...validSubscriptions,
                ...validWebinars,
                ...validClasses,
              ];
              allValidEvents.forEach((event: any) => {
                const type =
                  event.type?.toLowerCase() ||
                  (event.consultationPlan
                    ? "consultation"
                    : event.subscriptionPlan
                      ? "subscription"
                      : event.webinarPlan
                        ? "webinar"
                        : "class");

                // Verify event exists
                cy.get(`[data-testid="${type}-${event.id}"]`).should("exist");

                // Get slots for this event
                const eventSlots = getEventSlots(event);

                // Verify each slot appears in the correct section
                eventSlots.forEach((slot: any) => {
                  const start = new Date(slot.startTime);
                  const end = slot.endTime ? new Date(slot.endTime) : undefined;

                  // Format date components
                  const weekday = start.toLocaleString("en-US", {
                    weekday: "short",
                  });
                  const day = start.getDate();
                  const month = start.toLocaleString("en-US", {
                    month: "short",
                  });
                  const year = start.getFullYear();

                  const timeStr = end
                    ? `${formatTimeString(start)} - ${formatTimeString(end)}`
                    : formatTimeString(start);

                  // Format for upcoming section (with commas)
                  const upcomingText = `${weekday}, ${day} ${month} ${year}, ${timeStr}`;

                  // Format for monthly section (date and time separate)
                  const monthlyDateText = `${weekday}, ${day} ${month} ${year}`;
                  const monthlyTimeText = timeStr;

                  // Check if slot is in the future
                  const now = new Date();
                  const isFutureSlot = start > now;

                  // Check if slot is in current month
                  const isMonthlySlot = isInCurrentMonth(start);

                  cy.get("body").then(($body) => {
                    // If it's a future slot, it should be in the upcoming section
                    if (isFutureSlot) {
                      const upcomingSlots = Array.from(
                        $body.find('[data-testid="slot-datetime"]'),
                      );
                      const foundInUpcoming = upcomingSlots.some((el) =>
                        el.textContent?.includes(upcomingText),
                      );
                      expect(
                        foundInUpcoming,
                        `Expected future slot to be in upcoming section with format: "${upcomingText}"`,
                      ).to.equal(true);
                    }

                    // If it's in current month, it should be in monthly section
                    if (isMonthlySlot) {
                      const monthlySlots = Array.from(
                        $body.find('[data-testid="monthly-slot"]'),
                      );
                      const foundInMonthly = monthlySlots.some((el) => {
                        const text = el.textContent || "";
                        return (
                          text.includes(monthlyDateText) &&
                          text.includes(monthlyTimeText)
                        );
                      });
                      expect(
                        foundInMonthly,
                        `Expected current month slot to be in monthly section with date: "${monthlyDateText}" and time: "${monthlyTimeText}"`,
                      ).to.equal(true);
                    }
                  });
                });
              });
            },
          );
        },
      );
    });
  },
);
