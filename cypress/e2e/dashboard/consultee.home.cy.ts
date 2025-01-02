import { setupConsulteeDashboard } from "./consultee-setup.cy";
import consulteeIdsFixture from "../../fixtures/consultee-ids.json";

interface ConsulteeIdsFixture {
  consulteeIds: string[];
}

interface Slot {
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
  isTentative: boolean;
  event: {
    id: string;
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
    const slots = event.appointment?.slotsOfAppointment || 
                 event.appointments?.flatMap((apt: any) => apt.slotsOfAppointment) || [];
    return slots.map((slot: any) => ({
      ...slot,
      event
    }));
  });
}

function getMonthYearString(date: Date): string {
  return date.toLocaleString('default', { month: 'long', year: 'numeric' });
}

(consulteeIdsFixture as unknown as ConsulteeIdsFixture).consulteeIds.forEach((consulteeId) => {
  describe(`Consultee Home Page - ID: ${consulteeId}`, () => {
    beforeEach(() => {
      cy.exec("mkdir -p cypress/logs");
      cy.writeFile("cypress/logs/info.json", []);
      setupConsulteeDashboard(consulteeId, 'home');
    });

    it('verifies all slots from API appear in the UI', () => {
      cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses', '@getWebinars']).then((interceptions: any[]) => {
        // Get all slots from API
        const allSlots = interceptions.flatMap((interception) => {
          const events = interception.response?.body?.data || [];
          return getAllSlots(events);
        });

        // Log total slots for debugging
        cy.writeFile('cypress/logs/info.json', [{
          timestamp: new Date().toISOString(),
          type: 'total_slots',
          count: allSlots.length,
          consulteeId
        }]);

        // Group slots by month
        const slotsByMonth = allSlots.reduce<Record<string, Slot[]>>((acc, slot) => {
          const date = new Date(slot.slotStartTimeInUTC);
          const key = `${date.getFullYear()}-${date.getMonth()}`;
          if (!acc[key]) {
            acc[key] = [];
          }
          acc[key].push(slot);
          return acc;
        }, {});

        // Verify upcoming section
        cy.log('Verifying upcoming section');
        cy.get('[data-testid="upcoming-slot-list"] [data-testid^="webinar-"], [data-testid^="class-"], [data-testid^="consultation-"], [data-testid^="subscription-"]')
          .should('have.length', allSlots.length);

        // Test upcoming section navigation if there are slots
        if (allSlots.length > 0) {
          cy.log('Testing upcoming section navigation');
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

        // Verify monthly section
        cy.log('Verifying monthly section');
        const months = Object.entries(slotsByMonth)
          .map(([key, slots]) => {
            const [year, month] = key.split('-').map(Number);
            return {
              date: new Date(year, month),
              slots
            };
          })
          .sort((a, b) => a.date.getTime() - b.date.getTime());

        if (months.length > 0) {
          // Navigate to each month and verify slots
          months.forEach(({ date, slots }) => {
            const monthString = getMonthYearString(date);
            cy.log(`Checking month: ${monthString}`);

            // Navigate to month
            cy.get('[data-testid="monthly-slot-list"]').parent().find('h2').invoke('text').then((currentMonth) => {
              while (currentMonth !== monthString) {
                if (new Date(currentMonth).getTime() > date.getTime()) {
                  cy.get('[data-testid="prev-month"]').click();
                } else {
                  cy.get('[data-testid="next-month"]').click();
                }
                cy.wait(200);
                cy.get('[data-testid="monthly-slot-list"]').parent().find('h2').invoke('text').then((newMonth) => {
                  if (newMonth === monthString) {
                    return false; // Break the loop
                  }
                });
              }
            });

            // Verify slots for this month
            cy.get('[data-testid="monthly-slot"]')
              .should('have.length', slots.length)
              .then(() => {
                cy.writeFile('cypress/logs/info.json', [{
                  timestamp: new Date().toISOString(),
                  type: 'monthly_verification',
                  month: monthString,
                  expectedSlots: slots.length,
                  actualSlots: slots.length,
                  consulteeId
                }]);
              });
          });
        }
      });
    });
  });
});
