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

  describe('Home Tab', () => {
    it('displays correct status badges for each event', { defaultCommandTimeout: 30000 }, () => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'test_start',
          test: 'displays correct status badges for each event'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      // Verify consultation status
      cy.wait('@getConsultations').then((interception) => {
        const consultations = interception.response?.body.data;
        consultations.forEach((consultation: any) => {
          cy.get(`[data-testid="consultation-${consultation.id}"]`).first().within(() => {
            cy.get('[data-testid="event-status"]').should('contain', consultation.requestStatus);
          });
        });
      });

      // Verify subscription status
      cy.wait('@getSubscriptions').then((interception) => {
        const subscriptions = interception.response?.body.data;
        subscriptions.forEach((subscription: any) => {
          cy.get(`[data-testid="subscription-${subscription.id}"]`).first().within(() => {
            cy.get('[data-testid="event-status"]').should('contain', subscription.requestStatus);
          });
        });
      });

      // Verify class status
      cy.wait('@getClasses').then((interception) => {
        const classes = interception.response?.body.data;
        classes.forEach((classItem: any) => {
          cy.get(`[data-testid="class-${classItem.id}"]`).first().within(() => {
            cy.get('[data-testid="event-status"]').should('contain', classItem.status);
          });
        });
      });
    });

    it('displays correct consultant information in upcoming sessions', { defaultCommandTimeout: 30000 }, () => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'test_start',
          test: 'displays correct consultant information in upcoming sessions'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      // Verify consultant information in both upcoming and monthly sections
      ['consultations', 'subscriptions', 'classes'].forEach((eventType) => {
        cy.wait(`@get${eventType.charAt(0).toUpperCase() + eventType.slice(1)}`).then((interception) => {
          const events = interception.response?.body.data;
          events.forEach((event: any) => {
            const consultantName = event.consultationPlan?.consultantProfile?.user?.name || 
                               event.subscriptionPlan?.consultantProfile?.user?.name || 
                               event.classPlan?.consultantProfile?.user?.name;
            
            if (consultantName) {
              // Find the event in either upcoming or monthly section
              cy.get(`[data-testid="${eventType.slice(0, -1)}-${event.id}"]`).first().should('exist').within(() => {
                cy.get('[data-testid="consultant-name"]').should('contain', consultantName);
              });
            }
          });
        });
      });
    });

    it('shows tentative schedule notices correctly', { defaultCommandTimeout: 30000 }, () => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'test_start',
          test: 'shows tentative schedule notices correctly'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      // Check subscriptions for tentative schedules
      cy.wait('@getSubscriptions').then((interception) => {
        const subscriptions = interception.response?.body.data;
        subscriptions.forEach((subscription: any) => {
          if (subscription.tentativeSchedule) {
            cy.get(`[data-testid="subscription-${subscription.id}"]`).first().within(() => {
              cy.get('[data-testid="tentative-notice"]').should('contain', '*Subject to change');
            });
          }
        });
      });

      // Check classes for tentative schedules
      cy.wait('@getClasses').then((interception) => {
        const classes = interception.response?.body.data;
        classes.forEach((classItem: any) => {
          if (classItem.tentativeSchedule) {
            cy.get(`[data-testid="class-${classItem.id}"]`).first().within(() => {
              cy.get('[data-testid="tentative-notice"]').should('contain', '*Subject to change');
            });
          }
        });
      });
    });

    it('displays correct time slots and formats in upcoming sessions', { defaultCommandTimeout: 30000 }, () => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'test_start',
          test: 'displays correct time slots and formats in upcoming sessions'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      const formatDateTime = (date: Date) => ({
        date: date.toLocaleString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
        time: date.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase()
      });

      // Verify time slots in both upcoming and monthly sections
      // Verify consultation slots
      cy.wait('@getConsultations').then((interception) => {
        const consultations = interception.response?.body.data;
        consultations.forEach((consultation: any) => {
          if (consultation.appointment?.slotsOfAppointment?.length) {
            consultation.appointment.slotsOfAppointment.forEach((slot: any) => {
              const start = new Date(slot.slotStartTimeInUTC);
              const formatted = formatDateTime(start);
              
              // Find the event in either upcoming or monthly section
              cy.get(`[data-testid="consultation-${consultation.id}"]`).first().should('exist').within(() => {
                cy.get('[data-testid="slot-datetime"]').should('contain', formatted.date)
                  .and('contain', formatted.time);
              });
            });
          }
        });
      });

      // Verify subscription slots
      cy.wait('@getSubscriptions').then((interception) => {
        const subscriptions = interception.response?.body.data;
        subscriptions.forEach((subscription: any) => {
          if (subscription.tentativeSchedule) {
            const slots = JSON.parse(subscription.tentativeSchedule);
            slots.forEach((slot: any) => {
              const start = new Date(slot.startTime);
              const formatted = formatDateTime(start);
              
              // Find the event in either upcoming or monthly section
              cy.get(`[data-testid="subscription-${subscription.id}"]`).first().should('exist').within(() => {
                cy.get('[data-testid="slot-datetime"]').should('contain', formatted.date)
                  .and('contain', formatted.time);
              });
            });
          }
        });
      });

      // Verify class slots
      cy.wait('@getClasses').then((interception) => {
        const classes = interception.response?.body.data;
        classes.forEach((classItem: any) => {
          if (classItem.tentativeSchedule) {
            const slots = JSON.parse(classItem.tentativeSchedule);
            slots.forEach((slot: any) => {
              const start = new Date(slot.startTime);
              const formatted = formatDateTime(start);
              
              // Find the event in either upcoming or monthly section
              cy.get(`[data-testid="class-${classItem.id}"]`).first().should('exist').within(() => {
                cy.get('[data-testid="slot-datetime"]').should('contain', formatted.date)
                  .and('contain', formatted.time);
              });
            });
          }
        });
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

  describe('Data Consistency', () => {
    it('verifies all API events are displayed in UI', { defaultCommandTimeout: 30000 }, () => {
      cy.readFile('cypress/logs/info.json').then((logs) => {
        logs.push({
          timestamp: new Date().toISOString(),
          type: 'test_start',
          test: 'verifies all API events are displayed in UI'
        });
        cy.writeFile('cypress/logs/info.json', logs);
      });

      // Wait for all API responses
      cy.wait(['@getConsultations', '@getSubscriptions', '@getClasses']).then(
        ([consultationsResp, subscriptionsResp, classesResp]) => {
          const consultations = consultationsResp.response?.body.data || [];
          const subscriptions = subscriptionsResp.response?.body.data || [];
          const classes = classesResp.response?.body.data || [];

          // Verify each consultation is displayed
          consultations.forEach((consultation: any) => {
            cy.get(`[data-testid="consultation-${consultation.id}"]`).should('exist');
          });

          // Verify each subscription is displayed
          subscriptions.forEach((subscription: any) => {
            cy.get(`[data-testid="subscription-${subscription.id}"]`).should('exist');
          });

          // Verify each class is displayed
          classes.forEach((classItem: any) => {
            cy.get(`[data-testid="class-${classItem.id}"]`).should('exist');
          });

          // Get total events from both upcoming and monthly sections
          cy.get('[data-testid^="consultation-"], [data-testid^="subscription-"], [data-testid^="class-"]')
            .should('have.length.at.least', consultations.length + subscriptions.length + classes.length);
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
});
