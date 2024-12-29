/// <reference types="cypress" />

import { consulteeIds, setupConsulteeDashboard } from "./consultee-setup.cy";

consulteeIds.forEach(consulteeId => {
  describe(`Consultee Dashboard - Home Tab Upcoming Sessions (ID: ${consulteeId})`, () => {
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
});
