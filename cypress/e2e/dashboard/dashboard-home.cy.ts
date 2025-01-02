import { setupConsulteeDashboard } from "./dashboard-setup.cy";
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

    it('verifies upcoming slots section', () => {
      cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses', '@getWebinars']).then((interceptions: any[]) => {
        // Get all slots from API
        const allSlots = interceptions.flatMap((interception) => {
          const events = interception.response?.body?.data || [];
          return getAllSlots(events);
        });

        // First filter by previous year (matching getActualSlots)
        const now = new Date();
        const previousYear = now.getFullYear() - 1;
        const validSlots = allSlots.filter(slot => {
          const slotDate = new Date(slot.slotStartTimeInUTC);
          return slotDate.getFullYear() > previousYear;
        });

        // Then filter future slots (matching getActualUpcomingSlots)
        const futureSlots = validSlots
          .filter(slot => new Date(slot.slotStartTimeInUTC) > now)
          .sort((a, b) => 
            new Date(a.slotStartTimeInUTC).getTime() - new Date(b.slotStartTimeInUTC).getTime()
          );

        // Log upcoming slots count
        cy.writeFile('cypress/logs/info.json', [{
          timestamp: new Date().toISOString(),
          type: 'upcoming_slots',
          count: futureSlots.length,
          consulteeId
        }]);

        // Verify upcoming section
        cy.log('Verifying upcoming section');
        cy.get('[data-testid="upcoming-slot-list"]')
          .find('[data-testid^="webinar-"], [data-testid^="class-"], [data-testid^="consultation-"], [data-testid^="subscription-"]')
          .should('have.length', futureSlots.length);

        // Test navigation if there are slots
        if (futureSlots.length > 0) {
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
      });
    });

    it('verifies monthly slots section', () => {
      cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses', '@getWebinars']).then((interceptions: any[]) => {
        // Get all slots from API
        const allSlots = interceptions.flatMap((interception) => {
          const events = interception.response?.body?.data || [];
          return getAllSlots(events);
        });

        // Filter slots by previous year (matching getActualSlots)
        const now = new Date();
        const previousYear = now.getFullYear() - 1;
        const validSlots = allSlots.filter(slot => {
          const slotDate = new Date(slot.slotStartTimeInUTC);
          return slotDate.getFullYear() > previousYear;
        });

        // Group by month
        const slotsByMonth = validSlots.reduce<Record<string, Slot[]>>((acc, slot) => {
          const date = new Date(slot.slotStartTimeInUTC);
          const key = `${date.getFullYear()}-${date.getMonth()}`;
          if (!acc[key]) {
            acc[key] = [];
          }
          acc[key].push(slot);
          return acc;
        }, {});

        // Get sorted months
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
          months.forEach(({ date, slots }, index) => {
            const monthString = getMonthYearString(date);
            cy.log(`Checking month: ${monthString}`);

            // Navigate to month
            cy.get('[data-testid="monthly-slot-list"]').parent().find('h2').then(($header) => {
              const currentMonth = $header.text();
              
              // If not on target month, navigate to it
              if (currentMonth !== monthString) {
                // Determine direction and click button
                const targetDate = date.getTime();
                const currentDate = new Date(currentMonth).getTime();
                
                const button = targetDate < currentDate ? 'prev-month' : 'next-month';
                cy.get(`[data-testid="${button}"]`).click();
                cy.wait(200);
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
