import { defineConfig } from "cypress";
import fs from "fs"; // Import Node.js fs module
import path from "path"; // Import Node.js path module

const errorLogPath = path.resolve(__dirname, "cypress/logs/error-logs.json");

export default defineConfig({
  e2e: {
    baseUrl: "http://localhost:3000",
    setupNodeEvents(on, config) {
      // implement node event listeners here

      // --- Task for logging errors ---
      on("task", {
        logError(errorInfo: any) {
          console.error("Logging Error via Task:", errorInfo.error?.message);
          try {
            // Ensure directory exists
            const logDir = path.dirname(errorLogPath);
            if (!fs.existsSync(logDir)) {
              fs.mkdirSync(logDir, { recursive: true });
            }
            
            // Read current errors, append new one, write back
            let errors: any[] = [];
            if (fs.existsSync(errorLogPath)) {
              const content = fs.readFileSync(errorLogPath, "utf-8");
              try {
                  const parsed = JSON.parse(content);
                  if (Array.isArray(parsed)) {
                      errors = parsed;
                  }
              } catch (e) {
                  console.error("Error parsing error log file, overwriting.");
              }
            }
            errors.push(errorInfo);
            fs.writeFileSync(errorLogPath, JSON.stringify(errors, null, 2));
            return null; // Indicate success
          } catch (e) {
            console.error("Failed to write to error log:", e);
            return null; // Still return null even on failure
          }
        },
        // Task to clear the log file
        clearErrorLog() {
           console.log("Clearing error log file via Task.");
           try {
             const logDir = path.dirname(errorLogPath);
             if (!fs.existsSync(logDir)) {
               fs.mkdirSync(logDir, { recursive: true });
             }
             fs.writeFileSync(errorLogPath, JSON.stringify([], null, 2));
             return null;
           } catch(e) {
              console.error("Failed to clear error log:", e);
              return null;
           }
        }
      });
      // --- End Task ---

      return config; // Return the config object
    },
    viewportWidth: 1920,
    viewportHeight: 1080,
    experimentalMemoryManagement: true,
    numTestsKeptInMemory: 5,
    retries: {
      runMode: 2,
      openMode: 0,
    },
  },
});
