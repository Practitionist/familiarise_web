import { setupConsulteeDashboard } from "./consultee-setup.cy";
import consulteeIdsFixture from "../../fixtures/consultee-ids.json";

interface ConsulteeIdsFixture {
  consulteeIds: string[];
}

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
    const slots = event.appointment?.slotsOfAppointment || 
                 event.appointments?.flatMap((apt: any) => apt.slotsOfAppointment) || [];
    return slots.map((slot: any) => ({
      ...slot,
      event
    }));
  });
}

function getEventType(event: Slot['event']): EventType {
  if (event.consultationPlan) return 'Consultation';
  if (event.subscriptionPlan) return 'Subscription';
  if (event.classPlan) return 'Class';
  if (event.webinarPlan) return 'Webinar';
  throw new Error(`Unknown event type for event: ${event.id}`);
}

function formatTimeForOverview(date: Date): string {
  // Format time to match Overview format: "h:mm am/pm" (no leading zero for hour, lowercase am/pm)
  const hour = date.getHours() % 12 || 12;
  const minute = date.getMinutes().toString().padStart(2, '0');
  const period = date.getHours() < 12 ? 'am' : 'pm';
  return `${hour}:${minute} ${period}`;
}

function formatTimeForCalendar(date: Date): string {
  // Format time to match Calendar format: "HH:mm" (24-hour with leading zero)
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

(consulteeIdsFixture as unknown as ConsulteeIdsFixture).consulteeIds.forEach((consulteeId) => {
  describe(`Consultee Appointments Page - ID: ${consulteeId}`, () => {
    beforeEach(() => {
      cy.exec("mkdir -p cypress/logs");
      cy.writeFile("cypress/logs/info.json", []);
      setupConsulteeDashboard(consulteeId, 'appointments');
    });

    it('verifies overview section shows all appointments', () => {
      // Wait for overview grid to load
      cy.get('[data-testid="overview-grid"]').should('be.visible');

      // First verify all section cards exist
      ['consultations', 'subscriptions', 'classes', 'webinars'].forEach(type => {
        cy.get(`[data-testid="${type}-card"]`).should('exist');
      });

      // Get all slots from API responses
      cy.get('@getConsultations').then((consultationsReq: any) => {
        const consultations = consultationsReq.response?.body?.data || [];
        cy.get('@getSubscriptions').then((subscriptionsReq: any) => {
          const subscriptions = subscriptionsReq.response?.body?.data || [];
          cy.get('@getClasses').then((classesReq: any) => {
            const classes = classesReq.response?.body?.data || [];
            cy.get('@getWebinars').then((webinarsReq: any) => {
              const webinars = webinarsReq.response?.body?.data || [];

              // Process all slots
              const allEvents = [...consultations, ...subscriptions, ...classes, ...webinars];
              const allSlots = getAllSlots(allEvents);

              // Log total slots for debugging
              cy.writeFile('cypress/logs/info.json', [{
                timestamp: new Date().toISOString(),
                type: 'total_slots',
                count: allSlots.length,
                consulteeId
              }]);

              // Group slots by event type
              const slotsByType = allSlots.reduce((acc, slot) => {
                const type = getEventType(slot.event).toLowerCase();
                if (!acc[type]) acc[type] = [];
                acc[type].push(slot);
                return acc;
              }, {} as Record<string, Slot[]>);

              // Log slot counts by type
              cy.writeFile('cypress/logs/info.json', [{
                timestamp: new Date().toISOString(),
                type: 'slots_by_type',
                counts: Object.fromEntries(
                  Object.entries(slotsByType).map(([type, slots]) => [type, slots.length])
                ),
                consulteeId
              }]);

              // Then verify slots for types that have them
              Object.entries(slotsByType).forEach(([type, slots]) => {
                if (slots.length > 0) {
                  const cardSelector = `[data-testid="${type}s-card"]`;
                  
                  // For subscriptions and classes, expand the schedule first
                  if (type === 'subscription' || type === 'class') {
                    // First verify the section card exists
                    cy.get(cardSelector).should('be.visible');

                    // Get all events of this type
                    const events = type === 'subscription' ? subscriptions : classes;
                    
                    // For each event that has slots
                    events.forEach(event => {
                      const eventSlots = slots.filter(slot => slot.event.id === event.id);
                      if (eventSlots.length > 0) {
                        // Find and expand this event's card
                        cy.get(`[data-testid="${type}-${event.id}"]`).within(() => {
                          // Click on accordion trigger and wait for expansion
                          cy.contains(type === 'subscription' ? 'Scheduled Sessions' : 'Class Schedule')
                            .click();
                          
                          // Wait for slot list to be visible
                          cy.get('[data-testid="slot-list"]').should('be.visible');

                          // Verify each slot's time format
                          eventSlots.forEach(slot => {
                            const startTime = formatTimeForOverview(new Date(slot.slotStartTimeInUTC));
                            const endTime = formatTimeForOverview(new Date(slot.slotEndTimeInUTC));
                            cy.contains(`${startTime} - ${endTime}`);
                          });
                        });
                      }
                    });
                  } else {
                    // For other types, verify the card exists and has content
                    cy.get(cardSelector).within(() => {
                      // Only verify if there are events of this type
                      if (slots.length > 0) {
                        cy.get(`[data-testid="slot-time"]`).should('exist');
                      }
                    });
                  }
                }
              });
            });
          });
        });
      });
    });

    it('verifies calendar view shows all appointments', () => {
      // Switch to calendar and wait for it to load
      cy.contains('button', 'Calendar').click();
      cy.get('.rounded-xl.border.bg-card').should('be.visible');

      // Get all slots from API responses
      cy.get('@getConsultations').then((consultationsReq: any) => {
        const consultations = consultationsReq.response?.body?.data || [];
        cy.get('@getSubscriptions').then((subscriptionsReq: any) => {
          const subscriptions = subscriptionsReq.response?.body?.data || [];
          cy.get('@getClasses').then((classesReq: any) => {
            const classes = classesReq.response?.body?.data || [];
            cy.get('@getWebinars').then((webinarsReq: any) => {
              const webinars = webinarsReq.response?.body?.data || [];

              // Process all slots
              const allEvents = [...consultations, ...subscriptions, ...classes, ...webinars];
              const allSlots = getAllSlots(allEvents);

              // Find the latest slot date
              const latestDate = allSlots.reduce((latest, slot) => {
                const slotDate = new Date(slot.slotStartTimeInUTC);
                return slotDate > latest ? slotDate : latest;
              }, new Date(0));

              // Group slots by month
              const slotsByMonth = allSlots.reduce((acc, slot) => {
                const date = new Date(slot.slotStartTimeInUTC);
                const key = `${date.getFullYear()}-${date.getMonth()}`;
                if (!acc[key]) acc[key] = [];
                acc[key].push(slot);
                return acc;
              }, {} as Record<string, Slot[]>);

              // Get current month from calendar
              cy.get('h2').invoke('text').then((currentMonthText) => {
                const currentDate = new Date(currentMonthText);
                let targetDate = currentDate;

                // Function to verify a month's slots
                const verifyMonth = () => {
                  const monthKey = `${targetDate.getFullYear()}-${targetDate.getMonth()}`;
                  const monthSlots = slotsByMonth[monthKey] || [];

                  // Verify each day's events
                  monthSlots.forEach(slot => {
                    const date = new Date(slot.slotStartTimeInUTC);
                    const dayNumber = date.getDate().toString();
                    const time = formatTimeForCalendar(date);
                    const type = getEventType(slot.event);
                    const title = slot.event[`${type.toLowerCase()}Plan`]?.title;
                    
                    // Find the day cell and verify event
                    cy.get('.grid.grid-cols-7')
                      .contains('div.font-medium.mb-1', dayNumber)
                      .parent()
                      .within(() => {
                        // Log what we're looking for
                        cy.log(`Looking for time: ${time} and title: ${title}`);
                        // Find the event button and verify its content
                        cy.get('button.w-full.text-left.text-xs')
                          .should('exist')
                          .and('contain', time);
                        if (title) {
                          cy.get('button.w-full.text-left.text-xs')
                            .should('contain', title);
                        }
                      });
                  });

                  // If we haven't reached the latest date, move to next month
                  if (targetDate < latestDate) {
                    cy.get('button').find('svg').parent().last().click();
                    cy.wait(500);
                    targetDate = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1);
                    verifyMonth();
                  }
                };

                // Start verifying from current month
                verifyMonth();
              });
            });
          });
        });
      });
    });
  });
});
