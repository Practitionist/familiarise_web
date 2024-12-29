/// <reference types="cypress" />

describe('Consultee Dashboard', () => {
  const consulteeId = '73318747-3425-4bb6-bba7-c3d6a6798441';

  beforeEach(() => {
    // Create logs directory and initialize info.json if needed
    cy.exec('mkdir -p cypress/logs');
    cy.writeFile('cypress/logs/info.json', [], { flag: 'w' });

    // Intercept API calls
    cy.intercept('GET', `/api/events/consultations?consulteeProfileId=${consulteeId}`).as('getConsultations');
    cy.intercept('GET', `/api/events/subscriptions?consulteeProfileId=${consulteeId}`).as('getSubscriptions');
    cy.intercept('GET', `/api/events/classes?consulteeProfileId=${consulteeId}`).as('getClasses');
    cy.intercept('GET', `/api/events/webinars?consulteeProfileId=${consulteeId}`).as('getWebinars');

    // Visit the consultee dashboard
    cy.visit(`/dashboard/consultee/${consulteeId}`);

    // Wait for API calls to complete and content to load
    cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses', '@getWebinars'], { timeout: 30000 }).then((interceptions) => {
      // Log all API responses for debugging
      interceptions.forEach((interception: any) => {
        cy.log(`${interception.request.url} Response:`, JSON.stringify(interception.response?.body, null, 2));
        
        // Log API response info
        cy.readFile('cypress/logs/info.json').then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: 'api_response',
            endpoint: interception.request.url,
            status: interception.response?.statusCode,
            data: interception.response?.body
          });
          cy.writeFile('cypress/logs/info.json', logs);
        });

        if (interception.response?.statusCode >= 400) {
          cy.writeFile('cypress/logs/api-errors.json', {
            timestamp: new Date().toISOString(),
            endpoint: interception.request.url,
            status: interception.response.statusCode,
            error: interception.response.body
          }, { flag: 'a+' });
        }
      });
    });

    // Wait for slot list to be visible and log it
    cy.get('[data-testid="slot-list"]', { timeout: 30000 }).should('exist').then(() => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'ui_state',
          message: 'Slot list element found'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });
    });

    // Verify loading state is gone and log it
    cy.contains('Loading user data...', { timeout: 30000 }).should('not.exist').then(() => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'ui_state',
          message: 'Loading state removed'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });
    });
  });

  afterEach(function() {
    // Log test failures
    if (this.currentTest?.state === 'failed') {
      cy.writeFile('cypress/logs/errors.json', {
        timestamp: new Date().toISOString(),
        test: this.currentTest.title,
        error: this.currentTest.err?.message,
        stack: this.currentTest.err?.stack
      }, { flag: 'a+' });
    }
  });

  // Log uncaught exceptions
  Cypress.on('uncaught:exception', (err) => {
    cy.writeFile('cypress/logs/uncaught-errors.json', {
      timestamp: new Date().toISOString(),
      error: err.message,
      stack: err.stack
    }, { flag: 'a+' });
    return false;
  });

  describe('Home Tab - Upcoming Sessions', () => {
    it('displays correct status badges', { defaultCommandTimeout: 30000 }, () => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'test_start',
          test: 'displays correct status badges in upcoming sessions'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      // Verify consultation status
      cy.wait('@getConsultations').then((interception) => {
        const consultations = interception.response?.body.data;
        consultations.forEach((consultation: any) => {
          cy.get(`[data-testid="consultation-${consultation.id}"]`).first().should('exist').within(() => {
            cy.get('[data-testid="event-status"]').should('contain', consultation.requestStatus);
          });
        });
      });

      // Verify subscription status
      cy.wait('@getSubscriptions').then((interception) => {
        const subscriptions = interception.response?.body.data;
        subscriptions.forEach((subscription: any) => {
          cy.get(`[data-testid="subscription-${subscription.id}"]`).first().should('exist').within(() => {
            cy.get('[data-testid="event-status"]').should('contain', subscription.requestStatus);
          });
        });
      });

      // Verify class status
      cy.wait('@getClasses').then((interception) => {
        const classes = interception.response?.body.data;
        classes.forEach((classItem: any) => {
          cy.get(`[data-testid="class-${classItem.id}"]`).first().should('exist').within(() => {
            cy.get('[data-testid="event-status"]').should('contain', classItem.status);
          });
        });
      });
    });

    it('shows correct consultant information', { defaultCommandTimeout: 30000 }, () => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'test_start',
          test: 'shows correct consultant information in upcoming sessions'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      // Helper function to get the correct data-testid prefix
      const getTestIdPrefix = (eventType: string) => {
        return eventType === 'classes' ? 'class' : eventType.slice(0, -1);
      };

      ['consultations', 'subscriptions', 'classes'].forEach((eventType) => {
        cy.wait(`@get${eventType.charAt(0).toUpperCase() + eventType.slice(1)}`).then((interception) => {
          const events = interception.response?.body.data;
          events.forEach((event: any) => {
            const consultantName = event.consultationPlan?.consultantProfile?.user?.name || 
                               event.subscriptionPlan?.consultantProfile?.user?.name || 
                               event.classPlan?.consultantProfile?.user?.name;
            
            if (consultantName) {
              const testIdPrefix = getTestIdPrefix(eventType);
              cy.get(`[data-testid="${testIdPrefix}-${event.id}"]`).first().should('exist').within(() => {
                cy.get('[data-testid="consultant-name"]').should('contain', consultantName);
              });
            }
          });
        });
      });
    });
  });

  describe('Home Tab - Monthly View', () => {
    it('displays correct monthly events', { defaultCommandTimeout: 30000 }, () => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'test_start',
          test: 'displays correct monthly events'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      // Wait for API responses
      cy.wait(['@getSubscriptions', '@getClasses']).then(([subscriptionsResp, classesResp]) => {
        const subscriptions = subscriptionsResp.response?.body.data || [];
        const classes = classesResp.response?.body.data || [];
        
        // Log the events for debugging
        cy.readFile('cypress/logs/info.json').then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: 'debug',
            message: 'Checking tentative schedules',
            data: {
              subscriptions: subscriptions.map((s: any) => ({ id: s.id, hasTentative: !!s.tentativeSchedule })),
              classes: classes.map((c: any) => ({ id: c.id, hasTentative: !!c.tentativeSchedule }))
            }
          });
          cy.writeFile('cypress/logs/info.json', logs);
        });

        // Verify monthly slots format
        cy.get('[data-testid="monthly-slot"]').each(($slot) => {
          cy.wrap($slot).invoke('text').then((text) => {
            // Verify date format (e.g., "Tue, 31 Dec 2024")
            expect(text).to.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Za-z]{3} \d{4}/);
            // Verify time format (e.g., "1:00 pm - 2:00 pm")
            expect(text).to.match(/\d{1,2}:\d{2} [ap]m - \d{1,2}:\d{2} [ap]m/);
          });
        });

        // Check for tentative events
        const hasTentativeEvents = subscriptions.some((s: any) => s.tentativeSchedule) || 
                                 classes.some((c: any) => c.tentativeSchedule);

        if (hasTentativeEvents) {
          // Log that we found tentative events
          cy.readFile('cypress/logs/info.json').then((logs) => {
            logs.push({
              timestamp: new Date().toISOString(),
              type: 'debug',
              message: 'Found tentative events, checking for notice'
            });
            cy.writeFile('cypress/logs/info.json', logs);
          });

          // Check for tentative notice in either upcoming or monthly sections
          cy.get('[data-testid="tentative-notice"]')
            .should('exist')
            .first()
            .should('contain', '*Subject to change');
        }
      });
    });

    it('allows navigation between months', { defaultCommandTimeout: 30000 }, () => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'test_start',
          test: 'allows navigation between months'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      // Get current month text
      cy.get('[data-testid="month-nav"]').find('h2').invoke('text').then((currentMonth) => {
        // Click next month
        cy.get('[data-testid="next-month"]').click();
        // Verify month changed
        cy.get('[data-testid="month-nav"]').find('h2').should('not.contain', currentMonth);

        // Click previous month
        cy.get('[data-testid="prev-month"]').click();
        // Verify back to original month
        cy.get('[data-testid="month-nav"]').find('h2').should('contain', currentMonth);
      });
    });
  });

  describe('Data Consistency', () => {
    it('verifies exact data consistency between API and UI', { defaultCommandTimeout: 30000 }, () => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'test_start',
          test: 'verifies exact data consistency between API and UI'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      // Wait for all API responses
      cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses']).then(
        ([consultationsResp, subscriptionsResp, classesResp]) => {
          const consultations = consultationsResp.response?.body.data || [];
          const subscriptions = subscriptionsResp.response?.body.data || [];
          const classes = classesResp.response?.body.data || [];

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
                return year > 2000;
              })
              .map((slot: any) => ({
                startTime: slot.slotStartTimeInUTC,
                endTime: slot.slotEndTimeInUTC,
                isTentative: false
              }));

            // If we have actual slots, return those
            if (actualSlots.length > 0) {
              return actualSlots;
            }

            // Otherwise try tentative slots
            if (event.tentativeSchedule) {
              try {
                return JSON.parse(event.tentativeSchedule)
                  .map((slot: any) => ({
                    startTime: slot.startTime,
                    endTime: slot.endTime,
                    isTentative: true
                  }));
              } catch (e) {
                console.error('Error parsing tentative schedule:', e);
              }
            }

            return [];
          }

          // Get all slots from all events
          const allSlots = [
            ...consultations.flatMap(getEventSlots),
            ...subscriptions.flatMap(getEventSlots),
            ...classes.flatMap(getEventSlots)
          ].sort((a: any, b: any) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

          // Log slots for debugging
          cy.readFile('cypress/logs/info.json').then((logs) => {
            logs.push({
              timestamp: new Date().toISOString(),
              type: 'debug',
              message: 'All slots',
              data: allSlots.map((slot: any) => ({
                start: slot.startTime,
                end: slot.endTime,
                isTentative: slot.isTentative
              }))
            });
            cy.writeFile('cypress/logs/info.json', logs);
          });

          // Filter to only future slots (like the UI does)
          const now = new Date();
          const futureSlots = allSlots.filter((slot: any) => new Date(slot.startTime) > now);

          // Verify all future slots are displayed
          cy.get('[data-testid="slot-datetime"]').should('have.length', futureSlots.length);

          // Verify each slot's time matches
          cy.get('[data-testid="slot-datetime"]').each(($slot, index) => {
            const slot = futureSlots[index];
            const start = new Date(slot.startTime);
            const end = slot.endTime ? new Date(slot.endTime) : undefined;
            
            const expectedText = formatDateTime(start, end);
            cy.wrap($slot).should('contain', expectedText);
          });

          // Verify all events are displayed in correct order
          const allEvents = [...consultations, ...subscriptions, ...classes];
          allEvents.forEach((event: any) => {
            const type = event.type || 
                        (event.consultationPlan ? 'consultation' : 
                         event.subscriptionPlan ? 'subscription' : 'class');
            
            // Verify event exists
            cy.get(`[data-testid="${type}-${event.id}"]`).should('exist');

            // Get slots for this event
            const eventSlots = getEventSlots(event);
            
            // Verify each slot appears somewhere in the UI
            eventSlots.forEach((slot: any) => {
              const start = new Date(slot.startTime);
              const end = slot.endTime ? new Date(slot.endTime) : undefined;
              const expectedText = formatDateTime(start, end);
              
              // Log the slot we're looking for
              cy.readFile('cypress/logs/info.json').then((logs) => {
                logs.push({
                  timestamp: new Date().toISOString(),
                  type: 'debug',
                  message: 'Looking for slot',
                  data: {
                    start: slot.startTime,
                    end: slot.endTime,
                    isTentative: slot.isTentative,
                    expectedText
                  }
                });
                cy.writeFile('cypress/logs/info.json', logs);
              });

              // Check if slot exists in either section
              cy.get('body').then($body => {
                const upcomingSlots = Array.from($body.find('[data-testid="slot-datetime"]'));
                const monthlySlots = Array.from($body.find('[data-testid="monthly-slot"]'));
                
                const found = upcomingSlots.some(el => el.textContent?.includes(expectedText)) ||
                             monthlySlots.some(el => el.textContent?.includes(expectedText));

                // Assert with custom error message
                expect(found, `Expected to find slot "${expectedText}" but it was not found in either section`).to.equal(true);
              });
            });
          });
        }
      );
    });

    function formatDateTime(start: Date, end?: Date): string {
      const dateStr = start.toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric"
      });

      const timeStr = end
        ? `${start
            .toLocaleString(undefined, {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            })
            .toLowerCase()} - ${end
            .toLocaleString(undefined, {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            })
            .toLowerCase()}`
        : start
            .toLocaleString(undefined, {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            })
            .toLowerCase();

      return `${dateStr}, ${timeStr}`;
    }
  });

  it('handles API errors gracefully', { defaultCommandTimeout: 30000 }, () => {
    cy.readFile('cypress/logs/info.json').then((logs) => {
      logs.push({
        timestamp: new Date().toISOString(),
        type: 'test_start',
        test: 'handles API errors gracefully'
      });
      cy.writeFile('cypress/logs/info.json', logs);
    });

    // Test error handling for each API endpoint
    ['Consultations', 'Subscriptions', 'Classes', 'Webinars'].forEach((eventType) => {
      cy.intercept(
        'GET',
        `/api/events/${eventType.toLowerCase()}?consulteeProfileId=${consulteeId}`,
        {
          statusCode: 500,
          body: { error: `Failed to fetch ${eventType}` }
        }
      ).as(`get${eventType}Error`);

      cy.visit(`/dashboard/consultee/${consulteeId}`);
      cy.get('.bg-red-50').should('contain', 'Error loading events');
    });
  });
});
