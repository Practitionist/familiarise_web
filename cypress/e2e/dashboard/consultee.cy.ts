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
    it('verifies all API events are displayed somewhere in UI', { defaultCommandTimeout: 30000 }, () => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'test_start',
          test: 'verifies all API events are displayed somewhere in UI'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      // Wait for all API responses
      cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses']).then(
        ([consultationsResp, subscriptionsResp, classesResp]) => {
          const consultations = consultationsResp.response?.body.data || [];
          const subscriptions = subscriptionsResp.response?.body.data || [];
          const classes = classesResp.response?.body.data || [];

          // Verify each event exists in either upcoming or monthly sections
          [...consultations, ...subscriptions, ...classes].forEach((event: any) => {
            const type = event.type || 
                        (event.consultationPlan ? 'consultation' : 
                         event.subscriptionPlan ? 'subscription' : 'class');
            
            cy.get(`[data-testid="${type}-${event.id}"]`).should('exist');
          });
        }
      );
    });

    it('verifies no extra events are displayed', { defaultCommandTimeout: 30000 }, () => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'test_start',
          test: 'verifies no extra events are displayed'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      // Get all event IDs from API responses
      cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses']).then(
        ([consultationsResp, subscriptionsResp, classesResp]) => {
          const apiEventIds = [
            ...(consultationsResp.response?.body.data || []).map((e: any) => e.id),
            ...(subscriptionsResp.response?.body.data || []).map((e: any) => e.id),
            ...(classesResp.response?.body.data || []).map((e: any) => e.id)
          ];

          // Check that each displayed event corresponds to an API event
          cy.get('[data-testid^="consultation-"], [data-testid^="subscription-"], [data-testid^="class-"]')
            .each(($el) => {
              const testId = $el.attr('data-testid') || '';
              const id = testId.split('-')[1];
              const found = apiEventIds.some(apiId => apiId.startsWith(id));
              expect(found).to.equal(true);
            });
        }
      );
    });
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
