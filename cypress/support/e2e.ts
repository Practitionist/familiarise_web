// ***********************************************************
// This example support/e2e.ts is processed and
// loaded automatically before your test files.
//
// This is a great place to put global configuration and
// behavior that modifies Cypress.
//
// You can change the location of this file or turn off
// automatically serving support files with the
// 'supportFile' configuration option.
//
// You can read more here:
// https://on.cypress.io/configuration
// ***********************************************************

// Import commands.js using ES2015 syntax:
import "./commands";

// --- Global Error Logging --- 

// Clear log file before the entire suite runs using a task
// Note: Placing before() in support file can be unreliable for tasks
// It's safer to call cy.task('clearErrorLog') in a top-level before() 
// in your actual spec files or a central setup file if needed.
before(() => {
  cy.task('clearErrorLog', null, { log: false });
});

// Log uncaught exceptions
Cypress.on("uncaught:exception", (err, runnable) => {
  const errorInfo = {
    timestamp: new Date().toISOString(),
    type: "uncaught",
    test: runnable.title,
    suite: runnable.parent?.title,
    error: {
      message: err.message,
      stack: err.stack,
    },
  };

  // Print error to Cypress command log
  cy.log(`**Uncaught Error:** ${err.message}`);
  console.error("Uncaught Exception:", errorInfo);

  // Log error using the Node.js task
  cy.task("logError", errorInfo, { log: false });

  // Prevent Cypress from failing the test on uncaught exceptions
  return false; 
});

// Log command failures
Cypress.on("fail", (error, runnable) => {
  const errorInfo = {
    timestamp: new Date().toISOString(),
    type: "fail", // Differentiate failure type
    test: runnable.title,
    suite: runnable.parent?.title,
    error: {
      message: error.message,
      stack: error.stack,
    },
  };

  // Print error to Cypress command log
  cy.log(`**Command Failure:** ${error.message}`);
  console.error("Command Failure:", errorInfo);

  // Log error using the Node.js task
  cy.task("logError", errorInfo, { log: false });

  // IMPORTANT: Do NOT re-throw error here when using cy.task()
  // The test will still fail because the original command failed.
  // throw error; 
});

// --- End Global Error Logging ---
