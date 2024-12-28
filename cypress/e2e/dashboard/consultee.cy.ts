/// <reference types="cypress" />

describe("Consultee Dashboard", () => {
  const consulteeId = "73318747-3425-4bb6-bba7-c3d6a6798441";

  beforeEach(() => {
    // Create logs directory if it doesn't exist
    cy.exec("mkdir -p cypress/logs");

    // Intercept API calls
    cy.intercept(
      "GET",
      `/api/events/consultations?consulteeProfileId=${consulteeId}`,
    ).as("getConsultations");
    cy.intercept(
      "GET",
      `/api/events/subscriptions?consulteeProfileId=${consulteeId}`,
    ).as("getSubscriptions");
    cy.intercept(
      "GET",
      `/api/events/classes?consulteeProfileId=${consulteeId}`,
    ).as("getClasses");
    cy.intercept(
      "GET",
      `/api/events/webinars?consulteeProfileId=${consulteeId}`,
    ).as("getWebinars");

    // Visit the consultee dashboard
    cy.visit(`/dashboard/consultee/${consulteeId}`);

    // Create logs directory and initialize info.json if needed
    cy.exec("mkdir -p cypress/logs");
    cy.writeFile("cypress/logs/info.json", [], { flag: "w" });

    // Wait for API calls to complete and content to load
    cy.wait(
      ["@getConsultations", "@getSubscriptions", "@getClasses", "@getWebinars"],
      { timeout: 10000 },
    ).then((interceptions) => {
      // Log all API responses for debugging
      interceptions.forEach((interception: any) => {
        cy.log(
          `${interception.request.url} Response:`,
          JSON.stringify(interception.response?.body, null, 2),
        );

        // Log API response info
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "api_response",
            endpoint: interception.request.url,
            status: interception.response?.statusCode,
            data: interception.response?.body,
          });
          cy.writeFile("cypress/logs/info.json", logs);
        });

        if (interception.response?.statusCode >= 400) {
          cy.writeFile(
            "cypress/logs/api-errors.json",
            {
              timestamp: new Date().toISOString(),
              endpoint: interception.request.url,
              status: interception.response.statusCode,
              error: interception.response.body,
            },
            { flag: "a+" },
          );
        }
      });
    });

    cy.get('[data-testid="slot-list"]', { timeout: 10000 })
      .should("exist")
      .then(() => {
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "ui_state",
            message: "Slot list element found",
          });
          cy.writeFile("cypress/logs/info.json", logs);
        });
      });

    // Verify loading state is gone
    cy.contains("Loading user data...")
      .should("not.exist")
      .then(() => {
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "ui_state",
            message: "Loading state removed",
          });
          cy.writeFile("cypress/logs/info.json", logs);
        });
      });
  });

  afterEach(function () {
    // Log test failures
    if (this.currentTest?.state === "failed") {
      cy.writeFile(
        "cypress/logs/errors.json",
        {
          timestamp: new Date().toISOString(),
          test: this.currentTest.title,
          error: this.currentTest.err?.message,
          stack: this.currentTest.err?.stack,
        },
        { flag: "a+" },
      );
    }
  });

  // Log uncaught exceptions
  Cypress.on("uncaught:exception", (err) => {
    cy.writeFile(
      "cypress/logs/uncaught-errors.json",
      {
        timestamp: new Date().toISOString(),
        error: err.message,
        stack: err.stack,
      },
      { flag: "a+" },
    );
    return false;
  });

  describe("API Data Consistency", () => {
    // Helper function to format date for comparison
    const formatDateTime = (date: Date) => ({
      date: date.toLocaleString("en-US", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
      time: date
        .toLocaleString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })
        .toLowerCase(),
    });

    // Helper function to get all visible slot dates in a month
    const getVisibleSlotDates = ($slots: any) => {
      const monthMap: { [key: string]: number } = {
        Jan: 0,
        Feb: 1,
        Mar: 2,
        Apr: 3,
        May: 4,
        Jun: 5,
        Jul: 6,
        Aug: 7,
        Sep: 8,
        Oct: 9,
        Nov: 10,
        Dec: 11,
      };

      const dates: number[] = [];
      $slots.each((_, el) => {
        cy.wrap(el)
          .find('[data-testid="monthly-slot"]')
          .first()
          .invoke("text")
          .then((text) => {
            const match = text.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\w+)/);
            if (match && monthMap[match[1]] !== undefined) {
              dates.push(monthMap[match[1]]);
            }
          });
      });
      return dates;
    };

    // Helper function to verify date parts in text
    const verifyDateParts = (element: any, dateStr: string) => {
      const [weekday, month, day, year] = dateStr.split(/,?\s+/);
      cy.wrap(element)
        .find('[data-testid="slot-datetime"]')
        .should("contain", month)
        .and("contain", day)
        .and("contain", year);
    };

    it(
      "shows all consultation slots from API",
      { defaultCommandTimeout: 10000 },
      () => {
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "test_start",
            test: "shows all consultation slots from API",
          });
          cy.writeFile("cypress/logs/info.json", logs);
        });

        cy.wait("@getConsultations").then((interception: any) => {
          const consultations = interception.response?.body.data;
          consultations.forEach((consultation: any) => {
            cy.get(`[data-testid="consultation-${consultation.id}"]`)
              .first()
              .should("exist")
              .within(() => {
                // Verify appointment slots if any
                if (consultation.appointment?.slotsOfAppointment?.length) {
                  consultation.appointment.slotsOfAppointment.forEach(
                    (slot: any) => {
                      const startTime = new Date(slot.slotStartTimeInUTC);
                      const endTime = new Date(slot.slotEndTimeInUTC);
                      const formattedStart = formatDateTime(startTime);
                      const formattedEnd = formatDateTime(endTime);
                      cy.get("div").then(($div) => {
                        verifyDateParts($div, formattedStart.date);
                        expect($div.text()).to.include(formattedStart.time);
                        expect($div.text()).to.include(formattedEnd.time);
                      });
                    },
                  );
                }

                // Verify preferred datetime if any
                if (consultation.preferredDateTime) {
                  const dateTime = new Date(consultation.preferredDateTime);
                  const formatted = formatDateTime(dateTime);
                  cy.get("div").then(($div) => {
                    verifyDateParts($div, formatted.date);
                    expect($div.text()).to.include(formatted.time);
                  });
                }
              });
          });
        });
      },
    );

    it(
      "shows all subscription slots from API",
      { defaultCommandTimeout: 10000 },
      () => {
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "test_start",
            test: "shows all subscription slots from API",
          });
          cy.writeFile("cypress/logs/info.json", logs);
        });

        cy.wait("@getSubscriptions").then((interception: any) => {
          const subscriptions = interception.response?.body.data;
          subscriptions.forEach((subscription: any) => {
            cy.get(`[data-testid="subscription-${subscription.id}"]`)
              .first()
              .should("exist")
              .within(() => {
                // Verify tentative schedule slots
                if (subscription.tentativeSchedule) {
                  const slots = JSON.parse(subscription.tentativeSchedule);
                  slots.forEach((slot: any) => {
                    const startTime = new Date(slot.startTime);
                    const endTime = new Date(slot.endTime);
                    const formattedStart = formatDateTime(startTime);
                    const formattedEnd = formatDateTime(endTime);
                    cy.get("div").then(($div) => {
                      verifyDateParts($div, formattedStart.date);
                      expect($div.text()).to.include(formattedStart.time);
                      expect($div.text()).to.include(formattedEnd.time);
                    });
                  });
                }

                // Verify appointment slots
                subscription.appointments?.forEach((appointment: any) => {
                  appointment.slotsOfAppointment?.forEach((slot: any) => {
                    const startTime = new Date(slot.slotStartTimeInUTC);
                    const endTime = new Date(slot.slotEndTimeInUTC);
                    const formattedStart = formatDateTime(startTime);
                    const formattedEnd = formatDateTime(endTime);
                    cy.get("div").then(($div) => {
                      verifyDateParts($div, formattedStart.date);
                      expect($div.text()).to.include(formattedStart.time);
                      expect($div.text()).to.include(formattedEnd.time);
                    });
                  });
                });
              });
          });
        });
      },
    );

    it(
      "shows all class slots from API",
      { defaultCommandTimeout: 10000 },
      () => {
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "test_start",
            test: "shows all class slots from API",
          });
          cy.writeFile("cypress/logs/info.json", logs);
        });

        cy.wait("@getClasses").then((interception: any) => {
          const classes = interception.response?.body.data;
          classes.forEach((classItem: any) => {
            cy.get(`[data-testid="class-${classItem.id}"]`)
              .first()
              .should("exist")
              .within(() => {
                // Verify tentative schedule slots
                if (classItem.tentativeSchedule) {
                  const slots = JSON.parse(classItem.tentativeSchedule);
                  slots.forEach((slot: any) => {
                    const startTime = new Date(slot.startTime);
                    const endTime = new Date(slot.endTime);
                    const formattedStart = formatDateTime(startTime);
                    const formattedEnd = formatDateTime(endTime);
                    cy.get("div").then(($div) => {
                      verifyDateParts($div, formattedStart.date);
                      expect($div.text()).to.include(formattedStart.time);
                      expect($div.text()).to.include(formattedEnd.time);
                    });
                  });
                }

                // Verify appointment slots
                if (classItem.appointment?.length) {
                  classItem.appointment.forEach((appointment: any) => {
                    if (appointment.slotsOfAppointment?.length) {
                      appointment.slotsOfAppointment.forEach((slot: any) => {
                        const startTime = new Date(slot.slotStartTimeInUTC);
                        const endTime = new Date(slot.slotEndTimeInUTC);
                        const formattedStart = formatDateTime(startTime);
                        const formattedEnd = formatDateTime(endTime);
                        cy.get("div").then(($div) => {
                          verifyDateParts($div, formattedStart.date);
                          expect($div.text()).to.include(formattedStart.time);
                          expect($div.text()).to.include(formattedEnd.time);
                        });
                      });
                    }
                  });
                }
              });
          });
        });
      },
    );

    it(
      "shows slots in correct monthly views",
      { defaultCommandTimeout: 10000, retries: 2 },
      () => {
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "test_start",
            test: "shows slots in correct monthly views",
          });
          cy.writeFile("cypress/logs/info.json", logs);
        });
        // Get all events with their slots
        cy.wait(["@getConsultations", "@getSubscriptions", "@getClasses"], {
          timeout: 10000,
        }).then(([consultationsResp, subscriptionsResp, classesResp]: any) => {
          // Log all slots for debugging
          const allSlots: Date[] = [];

          // Collect consultation slots
          consultationsResp.response?.body.data.forEach((consultation: any) => {
            if (consultation.preferredDateTime) {
              allSlots.push(new Date(consultation.preferredDateTime));
            }
          });

          // Collect subscription slots
          subscriptionsResp.response?.body.data.forEach((subscription: any) => {
            if (subscription.tentativeSchedule) {
              const slots = JSON.parse(subscription.tentativeSchedule);
              slots.forEach((slot: any) => {
                allSlots.push(new Date(slot.startTime));
              });
            }
          });

          // Collect class slots
          classesResp.response?.body.data.forEach((classItem: any) => {
            if (classItem.tentativeSchedule) {
              const slots = JSON.parse(classItem.tentativeSchedule);
              slots.forEach((slot: any) => {
                allSlots.push(new Date(slot.startTime));
              });
            }
          });

          cy.log(
            "All Slots:",
            allSlots.map((d) => d.toISOString()),
          );

          // Group slots by month
          const slotsByMonth = allSlots.reduce(
            (acc: { [key: number]: number }, date) => {
              const month = date.getMonth();
              acc[month] = (acc[month] || 0) + 1;
              return acc;
            },
            {},
          );

          cy.log("Slots by Month:", slotsByMonth);

          // For each month with slots, verify they appear in that month's view
          Object.entries(slotsByMonth).forEach(([month, count]) => {
            // Navigate to month if needed
            const currentMonth = new Date().getMonth();
            const monthDiff = Number(month) - currentMonth;
            if (monthDiff > 0) {
              for (let i = 0; i < monthDiff; i++) {
                cy.get('[data-testid="next-month"]').click();
                cy.wait(500); // Wait for animation
              }
            } else if (monthDiff < 0) {
              for (let i = 0; i < Math.abs(monthDiff); i++) {
                cy.get('[data-testid="prev-month"]').click();
                cy.wait(500); // Wait for animation
              }
            }

            // Verify slot count in this month
            cy.get('[data-testid="slot-list"]', { timeout: 10000 })
              .should("be.visible")
              .within(() => {
                cy.get('[data-testid="monthly-slot"]')
                  .should("be.visible")
                  .then(($slots) => {
                    const visibleSlots = getVisibleSlotDates($slots);
                    const monthSlots = visibleSlots.filter(
                      (m) => m === Number(month),
                    );
                    cy.readFile("cypress/logs/info.json").then((logs) => {
                      logs.push({
                        timestamp: new Date().toISOString(),
                        type: "test_progress",
                        message: `Month ${month} - Expected: ${count}, Found: ${monthSlots.length}`,
                        data: {
                          month,
                          expectedCount: count,
                          actualCount: monthSlots.length,
                        },
                      });
                      cy.writeFile("cypress/logs/info.json", logs);
                    });
                    cy.wrap(monthSlots).should("have.length", count);
                  });
              });
          });
        });
      },
    );

    it(
      "shows correct slot counts and no extra slots",
      { defaultCommandTimeout: 10000 },
      () => {
        cy.readFile("cypress/logs/info.json").then((logs) => {
          logs.push({
            timestamp: new Date().toISOString(),
            type: "test_start",
            test: "shows correct slot counts and no extra slots",
          });
          cy.writeFile("cypress/logs/info.json", logs);
        });
        cy.wait(["@getConsultations", "@getSubscriptions", "@getClasses"]).then(
          ([consultationsResp, subscriptionsResp, classesResp]: any) => {
            // Verify subscription slots
            subscriptionsResp.response?.body.data.forEach(
              (subscription: any) => {
                const expectedSlots = subscription.tentativeSchedule
                  ? JSON.parse(subscription.tentativeSchedule)
                  : [];
                cy.get(`[data-testid="subscription-${subscription.id}"]`)
                  .first()
                  .should("exist")
                  .within(() => {
                    // Verify exact count
                    cy.get('[data-testid="slot-list"] > *')
                      .should("have.length", expectedSlots.length)
                      .then(() => {
                        cy.readFile("cypress/logs/info.json").then((logs) => {
                          logs.push({
                            timestamp: new Date().toISOString(),
                            type: "assertion",
                            message: `Slot count matches expected: ${expectedSlots.length}`,
                            data: { expected: expectedSlots.length },
                          });
                          cy.writeFile("cypress/logs/info.json", logs);
                        });
                      });

                    // Verify each slot matches exactly one from API
                    if (expectedSlots.length > 0) {
                      cy.get('[data-testid="slot-list"] > *').each(($slot) => {
                        const slotText = $slot.text();
                        const formattedSlots = expectedSlots.map(
                          (expected: any) => {
                            const start = formatDateTime(
                              new Date(expected.startTime),
                            );
                            const end = formatDateTime(
                              new Date(expected.endTime),
                            );
                            return {
                              date: start.date,
                              startTime: start.time,
                              endTime: end.time,
                            };
                          },
                        );

                        cy.wrap(formattedSlots).should(
                          "satisfy",
                          (slots: any[]) =>
                            slots.some((slot) => {
                              const [weekday, month, day, year] =
                                slot.date.split(/,?\s+/);
                              return (
                                slotText.includes(month) &&
                                slotText.includes(day) &&
                                slotText.includes(year) &&
                                slotText.includes(slot.startTime) &&
                                slotText.includes(slot.endTime)
                              );
                            }),
                        );
                      });
                    }
                  });
              },
            );

            // Verify class slots
            classesResp.response?.body.data.forEach((classItem: any) => {
              const expectedSlots = classItem.tentativeSchedule
                ? JSON.parse(classItem.tentativeSchedule)
                : [];
              cy.get(`[data-testid="class-${classItem.id}"]`)
                .first()
                .should("exist")
                .within(() => {
                  // Verify exact count
                  cy.get('[data-testid="slot-list"] > *').should(
                    "have.length",
                    expectedSlots.length,
                  );

                  // Verify each slot matches exactly one from API
                  if (expectedSlots.length > 0) {
                    cy.get('[data-testid="slot-list"] > *').each(($slot) => {
                      const slotText = $slot.text();
                      const formattedSlots = expectedSlots.map(
                        (expected: any) => {
                          const start = formatDateTime(
                            new Date(expected.startTime),
                          );
                          const end = formatDateTime(
                            new Date(expected.endTime),
                          );
                          return {
                            date: start.date,
                            startTime: start.time,
                            endTime: end.time,
                          };
                        },
                      );

                      cy.wrap(formattedSlots).should(
                        "satisfy",
                        (slots: any[]) =>
                          slots.some((slot) => {
                            const [weekday, month, day, year] =
                              slot.date.split(/,?\s+/);
                            return (
                              slotText.includes(month) &&
                              slotText.includes(day) &&
                              slotText.includes(year) &&
                              slotText.includes(slot.startTime) &&
                              slotText.includes(slot.endTime)
                            );
                          }),
                      );
                    });
                  }
                });
            });

            // Verify consultation slots
            consultationsResp.response?.body.data.forEach(
              (consultation: any) => {
                cy.get(`[data-testid="consultation-${consultation.id}"]`)
                  .first()
                  .should("exist")
                  .within(() => {
                    if (consultation.preferredDateTime) {
                      // Should show exactly one slot with preferred datetime
                      cy.get('[data-testid="slot-list"] > *').should(
                        "have.length",
                        1,
                      );

                      const dateTime = formatDateTime(
                        new Date(consultation.preferredDateTime),
                      );
                      cy.get('[data-testid="slot-list"] > *').then(($slot) => {
                        const [weekday, month, day, year] =
                          dateTime.date.split(/,?\s+/);
                        expect($slot.text()).to.include(month);
                        expect($slot.text()).to.include(day);
                        expect($slot.text()).to.include(year);
                        expect($slot.text()).to.include(dateTime.time);
                      });
                    } else {
                      // Should not show any slots
                      cy.get('[data-testid="slot-list"] > *').should(
                        "have.length",
                        0,
                      );
                    }
                  });
              },
            );
          },
        );
      },
    );
  });
});
