/// <reference types="cypress" />
import { consulteeIds, setupConsulteeDashboard } from './consultee-setup.cy';

consulteeIds.forEach(consulteeId => {
  describe(`Consultee Dashboard - Home Tab Monthly View (ID: ${consulteeId})`, () => {
    beforeEach(() => {
      setupConsulteeDashboard(consulteeId);
    });

    afterEach(function() {
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
});
