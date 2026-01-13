import fs from "fs";
import path from "path";

interface PostmanRequest {
  method: string;
  header: Array<{ key: string; value: string }>;
  url: {
    raw: string;
    host: string[];
    path: string[];
  };
  body?: {
    mode: string;
    raw: string;
  };
}

interface PostmanItem {
  name: string;
  request?: PostmanRequest;
  item?: PostmanItem[];
}

interface PostmanCollection {
  info: {
    name: string;
    schema: string;
  };
  item: PostmanItem[];
  variable: Array<{
    key: string;
    value: string;
  }>;
  event: Array<{
    listen: string;
    script: {
      exec: string[];
      type: string;
    };
  }>;
}

async function extractMethodFromFile(filePath: string): Promise<string[]> {
  const content = await fs.promises.readFile(filePath, "utf8");
  const methods: string[] = [];

  // Next.js App Router exports HTTP methods
  if (content.includes("export async function GET")) methods.push("GET");
  if (content.includes("export async function POST")) methods.push("POST");
  if (content.includes("export async function PUT")) methods.push("PUT");
  if (content.includes("export async function DELETE")) methods.push("DELETE");
  if (content.includes("export async function PATCH")) methods.push("PATCH");

  return methods.length > 0 ? methods : ["GET"]; // Default to GET if no methods found
}

function getDefaultRequestBody(pathSegments: string[]): string {
  const lastSegment = pathSegments[pathSegments.length - 1];
  const parentSegment = pathSegments[pathSegments.length - 2];

  // Add specific request body templates based on the endpoint
  switch (true) {
    // Checkout endpoints
    case /checkout/.test(parentSegment):
      const paymentType = pathSegments[pathSegments.length - 3]; // class, consultation, etc.
      return JSON.stringify(
        {
          [`${paymentType}Id`]: `{{${paymentType}_id}}`,
          quantity: 1,
          currency: "USD",
          successUrl: "{{success_url}}",
          cancelUrl: "{{cancel_url}}",
        },
        null,
        2,
      );

    // Appointment endpoints
    case /appointments/.test(parentSegment):
      if (lastSegment === "reschedule") {
        return JSON.stringify(
          {
            newStartTime: "{{new_start_time}}",
            newEndTime: "{{new_end_time}}",
            reason: "Schedule conflict",
          },
          null,
          2,
        );
      }
      if (lastSegment === "cancel") {
        return JSON.stringify(
          {
            reason: "Unable to attend",
            requestRefund: false,
          },
          null,
          2,
        );
      }
      return JSON.stringify(
        {
          startTime: "{{start_time}}",
          endTime: "{{end_time}}",
          notes: "{{notes}}",
          type: "consultation",
        },
        null,
        2,
      );

    // Event booking endpoints
    case /events/.test(parentSegment):
      if (lastSegment === "book") {
        return JSON.stringify(
          {
            slotId: "{{slot_id}}",
            participantDetails: {
              name: "{{participant_name}}",
              email: "{{participant_email}}",
            },
          },
          null,
          2,
        );
      }
      return JSON.stringify(
        {
          title: "Event Title",
          description: "Event Description",
          startDate: "{{start_date}}",
          endDate: "{{end_date}}",
          maxParticipants: 10,
        },
        null,
        2,
      );

    // User management endpoints
    case /user/.test(parentSegment):
      if (lastSegment === "reviews") {
        return JSON.stringify(
          {
            rating: 5,
            comment: "Great experience!",
            consultantId: "{{consultant_id}}",
            sessionId: "{{session_id}}",
          },
          null,
          2,
        );
      }
      if (lastSegment === "support-tickets") {
        return JSON.stringify(
          {
            subject: "Issue Title",
            description: "Detailed description of the issue",
            priority: "medium",
            category: "technical",
          },
          null,
          2,
        );
      }
      if (lastSegment === "feedbacks") {
        return JSON.stringify(
          {
            type: "general",
            content: "Feedback message",
            rating: 4,
          },
          null,
          2,
        );
      }
      return JSON.stringify(
        {
          name: "{{name}}",
          email: "{{email}}",
          bio: "{{bio}}",
        },
        null,
        2,
      );

    // Slot management endpoints
    case /slots/.test(parentSegment):
      if (lastSegment === "custom") {
        return JSON.stringify(
          {
            startTime: "{{start_time}}",
            endTime: "{{end_time}}",
            type: "one-time",
            maxBookings: 1,
          },
          null,
          2,
        );
      }
      if (lastSegment === "weekly") {
        return JSON.stringify(
          {
            dayOfWeek: 1, // Monday
            startTime: "09:00",
            endTime: "17:00",
            timezone: "UTC",
          },
          null,
          2,
        );
      }
      return JSON.stringify(
        {
          availabilityPattern: "weekly",
          slots: [
            {
              dayOfWeek: 1,
              startTime: "09:00",
              endTime: "17:00",
            },
          ],
          timezone: "UTC",
        },
        null,
        2,
      );

    // Form endpoints
    case /form/.test(parentSegment):
      if (lastSegment === "onboarding") {
        return JSON.stringify(
          {
            personalInfo: {
              fullName: "{{full_name}}",
              phone: "{{phone}}",
              location: "{{location}}",
            },
            professionalInfo: {
              title: "{{title}}",
              experience: "{{experience}}",
              skills: ["{{skill_1}}", "{{skill_2}}"],
            },
          },
          null,
          2,
        );
      }
      return JSON.stringify(
        {
          formData: {},
          submissionType: "draft",
        },
        null,
        2,
      );

    // Webhook endpoints
    case /webhooks/.test(parentSegment):
      const provider = lastSegment;
      return JSON.stringify(
        {
          type: "payment.success",
          data: {
            id: `{{${provider}_payment_id}}`,
            status: "completed",
            amount: 1000,
            currency: "USD",
          },
        },
        null,
        2,
      );

    // Default empty body
    default:
      return "{}";
  }
}

interface QueryParam {
  key: string;
  value: string;
  description?: string;
}

function getDefaultQueryParams(pathSegments: string[]): QueryParam[] {
  const lastSegment = pathSegments[pathSegments.length - 1];
  const parentSegment = pathSegments[pathSegments.length - 2];

  switch (true) {
    case /events/.test(parentSegment):
      return [
        { key: "page", value: "1", description: "Page number" },
        { key: "limit", value: "10", description: "Items per page" },
        { key: "sort", value: "date", description: "Sort field" },
        { key: "order", value: "desc", description: "Sort order" },
      ];

    case /slots/.test(parentSegment):
      if (lastSegment === "availability") {
        return [
          {
            key: "startDate",
            value: "{{start_date}}",
            description: "Start date (ISO)",
          },
          {
            key: "endDate",
            value: "{{end_date}}",
            description: "End date (ISO)",
          },
          { key: "timezone", value: "UTC", description: "Timezone" },
        ];
      }
      return [];

    case /user/.test(parentSegment):
      if (["consultants", "consultees"].includes(lastSegment)) {
        return [
          { key: "page", value: "1" },
          { key: "limit", value: "10" },
          { key: "search", value: "{{search_term}}" },
          { key: "sortBy", value: "rating" },
        ];
      }
      return [];

    default:
      return [];
  }
}

function createRequestObject(
  method: string,
  pathSegments: string[],
): PostmanRequest {
  const queryParams = getDefaultQueryParams(pathSegments);
  const pathWithParams = pathSegments.map((segment) =>
    segment.startsWith("[") ? `{{${segment.replace(/[[\]]/g, "")}}}` : segment,
  );

  const request: PostmanRequest = {
    method,
    header: [
      { key: "Authorization", value: "Bearer {{auth_token}}" },
      { key: "Content-Type", value: "application/json" },
    ],
    url: {
      raw: `{{base_url}}/api/${pathWithParams.join("/")}${
        queryParams.length
          ? "?" + queryParams.map((p) => `${p.key}=${p.value}`).join("&")
          : ""
      }`,
      host: ["{{base_url}}"],
      path: ["api", ...pathWithParams],
    },
  };

  // Add request body for methods that typically include one
  if (["POST", "PUT", "PATCH"].includes(method)) {
    request.body = {
      mode: "raw",
      raw: getDefaultRequestBody(pathSegments),
    };
  }

  return request;
}

async function processDirectory(
  dirPath: string,
  basePath: string = "",
): Promise<PostmanItem[]> {
  const items: PostmanItem[] = [];
  const entries = await fs.promises.readdir(dirPath);

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    const stat = await fs.promises.stat(fullPath);

    if (stat.isDirectory()) {
      // Skip [...nextauth] directory as it's handled differently
      if (entry === "[...nextauth]") continue;

      // Create a new folder in Postman
      const folderName = entry.replace(/^\[|\]$/g, ""); // Remove [] from dynamic route params
      const subItems = await processDirectory(
        fullPath,
        path.join(basePath, entry),
      );

      if (subItems.length > 0) {
        // Group similar endpoints together
        const groupName =
          folderName.charAt(0).toUpperCase() + folderName.slice(1);
        const existingGroup = items.find((item) => item.name === groupName);

        if (existingGroup && existingGroup.item) {
          existingGroup.item.push(...subItems);
        } else {
          items.push({
            name: groupName,
            item: subItems,
          });
        }
      }
    } else if (entry === "route.ts") {
      // This is an API endpoint
      const methods = await extractMethodFromFile(fullPath);
      const pathSegments = basePath.split(path.sep).filter(Boolean);

      for (const method of methods) {
        items.push({
          name: `${pathSegments[pathSegments.length - 1]} [${method}]`,
          request: createRequestObject(method, pathSegments),
        });
      }
    }
  }

  return items;
}

async function generatePostmanCollection(): Promise<PostmanCollection> {
  const apiDir = path.join(process.cwd(), "app", "api");
  const items = await processDirectory(apiDir);

  // Read existing collection to preserve variables and events
  const existingCollection = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "postman-collection.json"),
      "utf8",
    ),
  );

  return {
    info: {
      name: "Familiarise Complete API Collection",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: items,
    variable: existingCollection.variable || [],
    event: existingCollection.event || [],
  };
}

// Generate and save the new collection
generatePostmanCollection()
  .then((newCollection) => {
    fs.writeFileSync(
      path.join(process.cwd(), "postman-collection.json"),
      JSON.stringify(newCollection, null, 2),
    );
    console.log("Postman collection updated successfully!");
  })
  .catch((error) => {
    console.error("Error updating Postman collection:", error);
    process.exit(1);
  });
