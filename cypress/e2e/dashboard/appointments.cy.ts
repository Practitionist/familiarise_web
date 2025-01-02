/// <reference types="cypress" />
import consulteeIdsFixture from "../../fixtures/consultee-ids.json";
import { formatDateTime, setupConsulteeDashboard } from "./consultee-setup.cy";

interface ConsulteeIdsFixture {
  consulteeIds: string[];
}

(consulteeIdsFixture as unknown as ConsulteeIdsFixture).consulteeIds.forEach(
  (consulteeId) => {
    describe(`Appointments Dashboard (ID: ${consulteeId})`, () => {
      beforeEach(() => {
        setupConsulteeDashboard(consulteeId);
        cy.visit(`/dashboard/consultee/${consulteeId}/appointments`);

        // Wait for content to load
        cy.contains("Consultee Appointments").should("be.visible");
      });

      it("should display Overview tab with all events correctly", () => {
        // Verify we're on Overview tab by default
        cy.get('[role="tab"][data-state="active"]').should("contain", "Overview");

        // Wait for all API responses and store them
        cy.wait(["@getConsultations", "@getSubscriptions", "@getWebinars", "@getClasses"]).then(
          ([consultationsResp, subscriptionsResp, webinarsResp, classesResp]) => {
            const consultations = consultationsResp.response?.body.data || [];
            const subscriptions = subscriptionsResp.response?.body.data || [];
            const webinars = webinarsResp.response?.body.data || [];
            const classes = classesResp.response?.body.data || [];

            // Verify each section exists
            cy.get('[data-testid="overview-grid"]').within(() => {
              cy.get('[data-testid="consultations-card"]').should("exist");
              cy.get('[data-testid="subscriptions-card"]').should("exist");
              cy.get('[data-testid="classes-card"]').should("exist");
              cy.get('[data-testid="webinars-card"]').should("exist");
            });

            // Verify consultations
            consultations.forEach((consultation: any) => {
              const slots = consultation.appointment?.slotsOfAppointment || [];
              if (slots.length > 0) {
                cy.get(`[data-testid="consultation-${consultation.id}"]`).within(() => {
                  cy.contains(consultation.consultationPlan.title);
                  cy.contains(consultation.consultationPlan.consultantProfile.user.name);
                  cy.contains(consultation.requestStatus);
                });
              }
            });

            // Verify subscriptions
            subscriptions.forEach((subscription: any) => {
              const slots = subscription.appointments?.flatMap((a: any) => a.slotsOfAppointment) || [];
              if (slots.length > 0) {
                cy.get(`[data-testid="subscription-${subscription.id}"]`).within(() => {
                  cy.contains(subscription.subscriptionPlan.title);
                  cy.contains(subscription.subscriptionPlan.consultantProfile.user.name);
                  cy.contains(subscription.requestStatus);
                });
              }
            });

            // Verify classes
            classes.forEach((classItem: any) => {
              const slots = classItem.appointments?.flatMap((a: any) => a.slotsOfAppointment) || [];
              if (slots.length > 0) {
                cy.get(`[data-testid="class-${classItem.id}"]`).within(() => {
                  cy.contains(classItem.classPlan.title);
                  cy.contains(classItem.classPlan.consultantProfile.user.name);
                  cy.contains(classItem.status);
                });
              }
            });

            // Verify webinars
            webinars.forEach((webinar: any) => {
              const slots = webinar.appointment?.slotsOfAppointment || [];
              if (slots.length > 0) {
                cy.get(`[data-testid="webinar-${webinar.id}"]`).within(() => {
                  cy.contains(webinar.webinarPlan.title);
                  cy.contains(webinar.webinarPlan.consultantProfile.user.name);
                  cy.contains(webinar.status);
                });
              }
            });
          }
        );
      });

      it("should switch to Calendar tab and display events", () => {
        // Switch to Calendar tab
        cy.get('[role="tab"]').contains("Calendar").click();
        cy.get('[role="tab"][data-state="active"]').should("contain", "Calendar");

        // Wait for all API responses
        cy.wait(["@getConsultations", "@getSubscriptions", "@getWebinars", "@getClasses"]).then(
          ([consultationsResp, subscriptionsResp, webinarsResp, classesResp]) => {
            const consultations = consultationsResp.response?.body.data || [];
            const subscriptions = subscriptionsResp.response?.body.data || [];
            const webinars = webinarsResp.response?.body.data || [];
            const classes = classesResp.response?.body.data || [];

            // Check if there are any events
            const hasEvents =
              consultations.some((c: any) => c.appointment?.slotsOfAppointment?.length > 0) ||
              subscriptions.some((s: any) => s.appointments?.some((a: any) => a.slotsOfAppointment?.length > 0)) ||
              webinars.some((w: any) => w.appointment?.slotsOfAppointment?.length > 0) ||
              classes.some((c: any) => c.appointments?.some((a: any) => a.slotsOfAppointment?.length > 0));

            if (hasEvents) {
              // Verify calendar navigation
              cy.get('[data-testid="next-month"]').click();
              cy.get('[data-testid="prev-month"]').click();

              // Verify event display format
              cy.get('[data-testid="monthly-slot"]').each(($slot) => {
                cy.wrap($slot)
                  .invoke("text")
                  .then((text) => {
                    // Verify date format (e.g., "Tue, 31 Dec")
                    expect(text).to.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Za-z]{3}/);
                    // Verify time format (e.g., "1:00 pm - 2:00 pm")
                    expect(text).to.match(/\d{1,2}:\d{2} [ap]m - \d{1,2}:\d{2} [ap]m/);
                  });
              });
            } else {
              // Verify empty state message
              cy.contains("No sessions this month").should("be.visible");
            }
          }
        );
      });

      it("should handle tentative slots correctly", () => {
        // Wait for all API responses
        cy.wait(["@getConsultations", "@getSubscriptions", "@getWebinars", "@getClasses"]).then(
          ([consultationsResp, subscriptionsResp, webinarsResp, classesResp]) => {
            const consultations = consultationsResp.response?.body.data || [];
            const subscriptions = subscriptionsResp.response?.body.data || [];
            const webinars = webinarsResp.response?.body.data || [];
            const classes = classesResp.response?.body.data || [];

            // Check if any events have tentative slots
            const hasTentativeSlots =
              consultations.some((c: any) => c.appointment?.slotsOfAppointment?.some((s: any) => s.isTentative)) ||
              subscriptions.some((s: any) => s.appointments?.some((a: any) => a.slotsOfAppointment?.some((s: any) => s.isTentative))) ||
              webinars.some((w: any) => w.appointment?.slotsOfAppointment?.some((s: any) => s.isTentative)) ||
              classes.some((c: any) => c.appointments?.some((a: any) => a.slotsOfAppointment?.some((s: any) => s.isTentative)));

            if (hasTentativeSlots) {
              // Verify tentative notice is displayed
              cy.contains("*Subject to change").should("be.visible");
            }
          }
        );
      });
    });
  }
);
