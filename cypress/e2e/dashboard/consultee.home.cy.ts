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

(consulteeIdsFixture as unknown as ConsulteeIdsFixture).consulteeIds.forEach((consulteeId) => {
  describe(`Consultee Home Page - ID: ${consulteeId}`, () => {
    beforeEach(() => {
      // Create logs directory and initialize info.json
      cy.exec("mkdir -p cypress/logs");
      cy.writeFile("cypress/logs/info.json", []);
      setupConsulteeDashboard(consulteeId, 'home');
    });

    it('displays upcoming events in correct timezone and order', () => {
      // Wait for API responses
      cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses', '@getWebinars']).then((interceptions: any[]) => {
        // Process each event type separately
        const eventsByType: EventsByType = {
          consultation: [],
          subscription: [],
          class: [],
          webinar: []
        };

        try {
          const logs: any[] = [];

          interceptions.forEach((interception) => {
            const eventType = getEventType(interception.request.url);
            const events = interception.response?.body?.data || [];

            // Add API data to logs
            logs.push({
              timestamp: new Date().toISOString(),
              type: 'api_data',
              eventType,
              count: events.length,
              consulteeId
            });

            events.forEach((event: any) => {
              const slots = event.appointment?.slotsOfAppointment || 
                          event.appointments?.flatMap((apt: any) => apt.slotsOfAppointment) || [];
              
              slots.forEach((slot: any) => {
                eventsByType[eventType].push({
                  id: event.id,
                  type: eventType,
                  startTime: new Date(slot.slotStartTimeInUTC),
                  endTime: new Date(slot.slotEndTimeInUTC),
                  status: event.status || event.requestStatus,
                  title: event.consultationPlan?.title || 
                        event.subscriptionPlan?.title || 
                        event.webinarPlan?.title || 
                        event.classPlan?.title,
                  consultant: event.consultationPlan?.consultantProfile?.user?.name || 
                            event.subscriptionPlan?.consultantProfile?.user?.name || 
                            event.webinarPlan?.consultantProfile?.user?.name || 
                            event.classPlan?.consultantProfile?.user?.name,
                  isTentative: slot.isTentative || false
                });
              });
            });
          });

          // Add processed events to logs
          logs.push({
            timestamp: new Date().toISOString(),
            type: 'processed_data',
            eventCounts: {
              consultation: eventsByType.consultation.length,
              subscription: eventsByType.subscription.length,
              class: eventsByType.class.length,
              webinar: eventsByType.webinar.length
            },
            consulteeId
          });

          // Write all logs at once
          cy.writeFile('cypress/logs/info.json', logs);

          // Sort all events by start time
          const allEvents = Object.values(eventsByType).flat()
            .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

          // Wait for UI to load
          cy.get('[data-testid="upcoming-slot-list"]').should('exist').then(() => {
            // Verify UI elements match sorted events
            cy.get('[data-testid="upcoming-slot-list"] [data-testid^="webinar-"], [data-testid^="class-"], [data-testid^="consultation-"], [data-testid^="subscription-"]')
              .should('have.length', allEvents.length)
              .each(($card, index) => {
                const event = allEvents[index];
                const expectedDateTime = formatUpcomingDateTime(event.startTime, event.endTime);
                
                cy.wrap($card).within(() => {
                  cy.contains(event.title);
                  cy.contains(event.consultant);
                  cy.contains(expectedDateTime);
                  cy.get('[data-testid="event-status"]').should('contain', event.status);
                  
                  if (event.status === 'PENDING' || event.isTentative) {
                    cy.contains('*Subject to change');
                  }
                });
              });
          });
        } catch (err) {
          cy.writeFile('cypress/logs/info.json', [{
            timestamp: new Date().toISOString(),
            type: 'error',
            message: 'Critical error in test',
            error: err.message,
            consulteeId
          }]);
          throw err;
        }
      });
    });

    it('displays monthly events correctly', () => {
      const currentMonth = new Date().getMonth();
      const currentYear = new Date().getFullYear();

      cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses', '@getWebinars']).then((interceptions: any[]) => {
        const monthlyEvents: Event[] = [];
        const logs: any[] = [];

        try {
          interceptions.forEach((interception) => {
            const eventType = getEventType(interception.request.url);
            const events = interception.response?.body?.data || [];

            events.forEach((event: any) => {
              const slots = event.appointment?.slotsOfAppointment || 
                          event.appointments?.flatMap((apt: any) => apt.slotsOfAppointment) || [];
              
              slots.forEach((slot: any) => {
                const startTime = new Date(slot.slotStartTimeInUTC);
                if (startTime.getMonth() === currentMonth && startTime.getFullYear() === currentYear) {
                  monthlyEvents.push({
                    id: event.id,
                    type: eventType,
                    startTime,
                    endTime: new Date(slot.slotEndTimeInUTC),
                    status: event.status || event.requestStatus,
                    title: event.consultationPlan?.title || 
                          event.subscriptionPlan?.title || 
                          event.webinarPlan?.title || 
                          event.classPlan?.title,
                    consultant: event.consultationPlan?.consultantProfile?.user?.name || 
                              event.subscriptionPlan?.consultantProfile?.user?.name || 
                              event.webinarPlan?.consultantProfile?.user?.name || 
                              event.classPlan?.consultantProfile?.user?.name,
                    isTentative: slot.isTentative || false
                  });
                }
              });
            });
          });

          // Add monthly events to logs
          logs.push({
            timestamp: new Date().toISOString(),
            type: 'monthly_events',
            count: monthlyEvents.length,
            consulteeId
          });

          // Write logs
          cy.writeFile('cypress/logs/info.json', logs);

          // Sort events by date
          monthlyEvents.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

          // Wait for UI to load
          cy.get('[data-testid="monthly-slot-list"]').should('exist').then(() => {
            // Verify monthly view
            monthlyEvents.forEach((event) => {
              const expectedDateTime = formatMonthlyDateTime(event.startTime, event.endTime);
              cy.contains(event.title)
                .parent()
                .within(() => {
                  cy.contains(event.consultant);
                  cy.get('[data-testid="monthly-slot"]').should('contain', expectedDateTime);
                  cy.get('[data-testid="event-status"]').should('contain', event.status);
                  
                  if (event.status === 'PENDING' || event.isTentative) {
                    cy.contains('*Subject to change');
                  }
                });
            });
          });

          // Test month navigation
          cy.get('[data-testid="next-month"]').click();
          const nextMonth = new Date();
          nextMonth.setMonth(nextMonth.getMonth() + 1);
          cy.contains(nextMonth.toLocaleString('default', { month: 'long', year: 'numeric' }));
        } catch (err) {
          cy.writeFile('cypress/logs/info.json', [{
            timestamp: new Date().toISOString(),
            type: 'error',
            message: 'Error in monthly events test',
            error: err.message,
            consulteeId
          }]);
          throw err;
        }
      });
    });
  });
});
