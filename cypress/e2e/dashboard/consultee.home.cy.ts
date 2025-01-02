import { setupConsulteeDashboard } from "./consultee-setup.cy";
import consulteeIdsFixture from "../../fixtures/consultee-ids.json";

interface ConsulteeIdsFixture {
  consulteeIds: string[];
}

interface Event {
  id: string;
  type: string;
  startTime: Date;
  endTime: Date;
  status: string;
  title: string;
  consultant: string;
  isTentative: boolean;
}

interface EventsByType {
  consultation: Event[];
  subscription: Event[];
  class: Event[];
  webinar: Event[];
}

function formatTimeString(d: Date): string {
  let hours = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours >= 12 ? "pm" : "am";

  if (hours === 0) hours = 12;
  else if (hours > 12) hours -= 12;

  return `${hours}:${minutes.toString().padStart(2, "0")} ${ampm}`;
}

function formatUpcomingDateTime(date: Date, endTime?: Date): string {
  const weekday = date.toLocaleString(undefined, { weekday: "short" });
  const day = date.getDate();
  const month = date.toLocaleString(undefined, { month: "short" });
  const year = date.getFullYear();

  const timeStr = endTime
    ? `${formatTimeString(date)} - ${formatTimeString(endTime)}`
    : formatTimeString(date);

  return `${weekday}, ${day} ${month} ${year}, ${timeStr}`;
}

function formatMonthlyDateTime(date: Date, endTime?: Date): string {
  const weekday = date.toLocaleString(undefined, { weekday: "short" });
  const day = date.getDate();
  const month = date.toLocaleString(undefined, { month: "short" });

  const timeStr = endTime
    ? `${formatTimeString(date)} - ${formatTimeString(endTime)}`
    : formatTimeString(date);

  return `${weekday} ${day} ${month} ${timeStr}`;
}

function getEventType(url: string): keyof EventsByType {
  if (url.includes('/consultations')) return 'consultation';
  if (url.includes('/subscriptions')) return 'subscription';
  if (url.includes('/classes')) return 'class';
  if (url.includes('/webinars')) return 'webinar';
  throw new Error(`Unknown event type in URL: ${url}`);
}

function getAllSlots(events: any[]): any[] {
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

    it('displays all slots in upcoming events section', () => {
      cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses', '@getWebinars']).then((interceptions: any[]) => {
        const allSlots = interceptions.flatMap((interception) => {
          const events = interception.response?.body?.data || [];
          return getAllSlots(events);
        });

        // Sort all slots by start time
        const sortedSlots = allSlots.sort((a, b) => 
          new Date(a.slotStartTimeInUTC).getTime() - new Date(b.slotStartTimeInUTC).getTime()
        );

        // Log the counts
        cy.writeFile('cypress/logs/info.json', [{
          timestamp: new Date().toISOString(),
          type: 'slot_counts',
          totalSlots: allSlots.length,
          consulteeId
        }]);

        // Verify total number of slots
        cy.get('[data-testid="upcoming-slot-list"] [data-testid^="webinar-"], [data-testid^="class-"], [data-testid^="consultation-"], [data-testid^="subscription-"]')
          .should('have.length', sortedSlots.length);

        if (sortedSlots.length > 0) {
          // Verify each slot's content
          cy.get('[data-testid="upcoming-slot-list"] [data-testid^="webinar-"], [data-testid^="class-"], [data-testid^="consultation-"], [data-testid^="subscription-"]')
            .each(($card, index) => {
              const slot = sortedSlots[index];
              const event = slot.event;
              const startTime = new Date(slot.slotStartTimeInUTC);
              const endTime = new Date(slot.slotEndTimeInUTC);
              const expectedDateTime = formatUpcomingDateTime(startTime, endTime);
              
              cy.wrap($card).within(() => {
                cy.contains(event.consultationPlan?.title || 
                          event.subscriptionPlan?.title || 
                          event.webinarPlan?.title || 
                          event.classPlan?.title);
                cy.contains(event.consultationPlan?.consultantProfile?.user?.name || 
                          event.subscriptionPlan?.consultantProfile?.user?.name || 
                          event.webinarPlan?.consultantProfile?.user?.name || 
                          event.classPlan?.consultantProfile?.user?.name);
                cy.contains(expectedDateTime);
                cy.get('[data-testid="event-status"]').should('contain', event.status || event.requestStatus);
                
                if ((event.status || event.requestStatus) === 'PENDING' || slot.isTentative) {
                  cy.contains('*Subject to change');
                }
              });
            });
        }
      });
    });

    it('displays all slots in monthly view with navigation', () => {
      cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses', '@getWebinars']).then((interceptions: any[]) => {
        const allSlots = interceptions.flatMap((interception) => {
          const events = interception.response?.body?.data || [];
          return getAllSlots(events);
        });

        // Get unique months from all slots
        const months = Array.from(new Set(
          allSlots.map(slot => {
            const date = new Date(slot.slotStartTimeInUTC);
            return `${date.getFullYear()}-${date.getMonth()}`;
          })
        )).map(monthStr => {
          const [year, month] = monthStr.split('-').map(Number);
          return new Date(year, month);
        }).sort((a, b) => a.getTime() - b.getTime());

        if (months.length > 0) {
          // For each month with events, navigate to it and verify slots
          months.forEach((month) => {
            // Get current displayed month/year
            cy.get('[data-testid="monthly-slot-list"]').parent().find('h2').invoke('text').then((currentMonthText) => {
              const [currentMonth, currentYear] = currentMonthText.split(' ');
              const targetMonthText = getMonthYearString(month);
              
              // Navigate to target month
              while (!currentMonthText.includes(targetMonthText)) {
                if (new Date(`${currentMonth} ${currentYear}`).getTime() > month.getTime()) {
                  cy.get('[data-testid="prev-month"]').click();
                } else {
                  cy.get('[data-testid="next-month"]').click();
                }
                cy.wait(200); // Wait for UI update
              }
            });

            // Get slots for current month
            const monthlySlots = allSlots.filter(slot => {
              const date = new Date(slot.slotStartTimeInUTC);
              return date.getMonth() === month.getMonth() && 
                     date.getFullYear() === month.getFullYear();
            });

            // Verify slots for this month
            cy.get('[data-testid="monthly-slot"]')
              .should('have.length', monthlySlots.length);

            // Log monthly counts
            cy.writeFile('cypress/logs/info.json', [{
              timestamp: new Date().toISOString(),
              type: 'monthly_slot_counts',
              month: getMonthYearString(month),
              totalSlots: monthlySlots.length,
              consulteeId
            }]);
          });
        }
      });
    });
  });
});
