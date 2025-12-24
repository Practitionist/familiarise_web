/**
 * Utility functions for seed data generation
 */

import { faker } from "@faker-js/faker";

/**
 * Sanitizes a string by removing null bytes and control characters that can cause PostgreSQL errors
 */
export function sanitizeString(input: string): string {
  if (!input) return input;

  return (
    input
      .replace(/\0/g, "") // Remove null bytes
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, "") // Remove control characters
      .trim()
  );
}

/**
 * Sanitizes an email address while preserving validity
 */
export function sanitizeEmail(email: string): string {
  if (!email) return email;

  // Split email into local and domain parts
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1) return sanitizeString(email);

  const localPart = sanitizeString(email.substring(0, atIndex));
  const domainPart = sanitizeString(email.substring(atIndex + 1));

  // Ensure we have valid parts
  if (!localPart || !domainPart) {
    return "fallback@example.com";
  }

  return `${localPart}@${domainPart}`;
}

/**
 * Sanitizes a phone number while preserving format
 */
export function sanitizePhone(phone: string): string {
  if (!phone) return phone;

  // Remove null bytes and control characters, but keep phone number characters
  return (
    phone
      .replace(/\0/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
      .trim()
  );
}

/**
 * Random helper to pick from an array
 */
export function randomFromArray<T>(arr: T[]): T {
  return faker.helpers.arrayElement(arr);
}

/**
 * Generate a random date of birth for adults (18-65 years old)
 */
export function generateDateOfBirth(): Date {
  const now = new Date();
  const minAge = 18;
  const maxAge = 65;
  const minDate = new Date(
    now.getFullYear() - maxAge,
    now.getMonth(),
    now.getDate(),
  );
  const maxDate = new Date(
    now.getFullYear() - minAge,
    now.getMonth(),
    now.getDate(),
  );
  return faker.date.between({ from: minDate, to: maxDate });
}

/**
 * Generate a realistic bio (max 160 chars)
 */
export function generateBio(): string {
  const bios = [
    "Passionate about helping others grow. Technology enthusiast and lifelong learner.",
    "Experienced professional dedicated to mentoring the next generation of leaders.",
    "Building bridges between ambition and achievement through personalized guidance.",
    "Turning career challenges into opportunities for growth and success.",
    "Committed to unlocking potential and fostering professional development.",
    "Helping professionals navigate their career journey with clarity and purpose.",
    "Your success is my mission. Let's achieve your goals together.",
    "Bringing 10+ years of industry experience to help you succeed.",
    "Career strategist helping professionals reach their full potential.",
    "Transforming careers through expert guidance and actionable insights.",
  ];
  return faker.helpers.arrayElement(bios);
}

/**
 * Generate a professional headline (max 120 chars)
 */
export function generateHeadline(domain: string): string {
  const headlines = [
    `Senior ${domain} Expert | Helping Professionals Excel`,
    `${domain} Consultant | Career Coach | Mentor`,
    `Experienced ${domain} Professional | Building Future Leaders`,
    `${domain} Specialist | 10+ Years Experience`,
    `${domain} Mentor | Transforming Careers`,
    `Award-winning ${domain} Consultant | Speaker`,
    `${domain} Strategist | Executive Coach`,
    `Certified ${domain} Expert | Industry Leader`,
  ];
  return faker.helpers.arrayElement(headlines);
}

/**
 * Generate programming languages/spoken languages
 */
export function generateLanguages(): string[] {
  const languages = [
    "English",
    "Spanish",
    "French",
    "German",
    "Chinese",
    "Hindi",
    "Portuguese",
    "Japanese",
    "Korean",
    "Arabic",
    "Italian",
    "Russian",
  ];
  const count = faker.number.int({ min: 1, max: 4 });
  return faker.helpers.arrayElements(languages, count);
}

/**
 * Generate tools and technologies based on domain
 */
export function generateToolsAndTechnologies(domain: string): string[] {
  const toolsByDomain: Record<string, string[]> = {
    Technology: [
      "JavaScript",
      "TypeScript",
      "Python",
      "React",
      "Node.js",
      "AWS",
      "Docker",
      "Kubernetes",
      "Git",
      "PostgreSQL",
      "MongoDB",
      "Redis",
      "GraphQL",
      "REST APIs",
    ],
    Business: [
      "Excel",
      "PowerPoint",
      "Tableau",
      "Power BI",
      "Salesforce",
      "HubSpot",
      "SAP",
      "Jira",
      "Confluence",
      "Slack",
    ],
    Health: [
      "EMR Systems",
      "Telehealth Platforms",
      "HIPAA Compliance",
      "Health Analytics",
      "Patient Management",
    ],
    Education: [
      "LMS Platforms",
      "Moodle",
      "Canvas",
      "Google Classroom",
      "Zoom",
      "Microsoft Teams",
    ],
    "Creative Arts": [
      "Adobe Photoshop",
      "Adobe Illustrator",
      "Figma",
      "Sketch",
      "InVision",
      "After Effects",
      "Premiere Pro",
    ],
    "Personal Development": [
      "Coaching Frameworks",
      "Assessment Tools",
      "Goal Setting Methods",
      "Time Management Systems",
    ],
  };

  const tools = toolsByDomain[domain] || toolsByDomain["Technology"];
  const count = faker.number.int({ min: 3, max: 8 });
  return faker.helpers.arrayElements(tools, count);
}

/**
 * Generate mentoring style description
 */
export function generateMentoringStyle(): string {
  const styles = [
    "I believe in a collaborative approach where we work together to identify your goals and create actionable plans. My style is supportive yet challenging, pushing you to grow while providing the guidance you need.",
    "My mentoring philosophy centers on practical, hands-on learning. We'll tackle real-world challenges together, building your skills through direct experience and constructive feedback.",
    "I focus on building lasting habits and mindsets rather than quick fixes. Through structured sessions and accountability, we'll develop sustainable growth patterns that serve you long-term.",
    "I combine strategic thinking with emotional intelligence to help you navigate both technical and interpersonal challenges. Expect honest feedback delivered with empathy.",
    "My approach is highly personalized - I adapt my style to match your learning preferences and goals. Whether you need intensive coaching or gentle guidance, I adjust accordingly.",
    "I emphasize self-discovery and empowerment. Rather than giving you all the answers, I'll help you develop the frameworks and critical thinking skills to solve problems independently.",
  ];
  return faker.helpers.arrayElement(styles);
}

/**
 * Generate skills to develop for consultees
 */
export function generateSkillsToDevelop(): string[] {
  const skills = [
    "Leadership",
    "Communication",
    "Technical Skills",
    "Project Management",
    "Strategic Thinking",
    "Negotiation",
    "Public Speaking",
    "Data Analysis",
    "Problem Solving",
    "Time Management",
    "Team Collaboration",
    "Career Planning",
    "Networking",
    "Interview Skills",
    "Executive Presence",
  ];
  const count = faker.number.int({ min: 2, max: 5 });
  return faker.helpers.arrayElements(skills, count);
}

/**
 * Generate industries for consultees
 */
export function generateIndustry(): string {
  const industries = [
    "Technology",
    "Finance",
    "Healthcare",
    "Education",
    "Consulting",
    "Marketing",
    "Manufacturing",
    "Retail",
    "Real Estate",
    "Media & Entertainment",
    "Non-profit",
    "Government",
    "Legal",
    "Energy",
    "Telecommunications",
  ];
  return faker.helpers.arrayElement(industries);
}

/**
 * Generate staff skills
 */
export function generateStaffSkills(): string[] {
  const skills = [
    "Customer Support",
    "Technical Support",
    "Content Moderation",
    "Quality Assurance",
    "Training & Onboarding",
    "Data Entry",
    "Reporting & Analytics",
    "Process Improvement",
    "Compliance Monitoring",
    "Escalation Handling",
  ];
  const count = faker.number.int({ min: 2, max: 4 });
  return faker.helpers.arrayElements(skills, count);
}

/**
 * Generate work schedule for staff
 */
export function generateWorkSchedule(): string {
  const schedules = [
    "9 AM - 5 PM (Mon-Fri)",
    "10 AM - 6 PM (Mon-Fri)",
    "8 AM - 4 PM (Mon-Fri)",
    "Shift A: 6 AM - 2 PM",
    "Shift B: 2 PM - 10 PM",
    "Flexible Hours",
    "Part-time (20 hrs/week)",
    "Remote - Flexible",
  ];
  return faker.helpers.arrayElement(schedules);
}

/**
 * Generate realistic company names
 */
export function generateCompanyName(): string {
  const companies = [
    "Google",
    "Microsoft",
    "Amazon",
    "Meta",
    "Apple",
    "Netflix",
    "Salesforce",
    "Oracle",
    "IBM",
    "Accenture",
    "Deloitte",
    "McKinsey",
    "Goldman Sachs",
    "JP Morgan",
    "Stripe",
    "Uber",
    "Airbnb",
    "Spotify",
    "Adobe",
    "Cisco",
    "VMware",
    "Snowflake",
    "Databricks",
    "Palantir",
    "Coinbase",
    faker.company.name(),
    faker.company.name(),
    faker.company.name(),
  ];
  return faker.helpers.arrayElement(companies);
}

/**
 * Generate job titles
 */
export function generateJobTitle(domain: string): string {
  const titlesByDomain: Record<string, string[]> = {
    Technology: [
      "Software Engineer",
      "Senior Software Engineer",
      "Staff Engineer",
      "Principal Engineer",
      "Engineering Manager",
      "VP of Engineering",
      "CTO",
      "Tech Lead",
      "DevOps Engineer",
      "Data Scientist",
      "Product Manager",
    ],
    Business: [
      "Business Analyst",
      "Management Consultant",
      "Strategy Manager",
      "Operations Director",
      "VP of Operations",
      "COO",
      "Project Manager",
      "Business Development Manager",
    ],
    Health: [
      "Health Coach",
      "Wellness Consultant",
      "Fitness Director",
      "Nutrition Specialist",
      "Mental Health Counselor",
      "Physical Therapist",
    ],
    Education: [
      "Curriculum Developer",
      "Educational Consultant",
      "Training Manager",
      "Learning Designer",
      "Academic Advisor",
      "Department Head",
    ],
    "Creative Arts": [
      "Creative Director",
      "UI/UX Designer",
      "Art Director",
      "Brand Designer",
      "Motion Designer",
      "Design Lead",
    ],
    "Personal Development": [
      "Life Coach",
      "Career Coach",
      "Executive Coach",
      "Leadership Consultant",
      "Performance Coach",
    ],
  };

  const titles = titlesByDomain[domain] || titlesByDomain["Technology"];
  return faker.helpers.arrayElement(titles);
}

/**
 * Generate certification names based on domain
 */
export function generateCertificationName(domain: string): string {
  const certsByDomain: Record<string, string[]> = {
    Technology: [
      "AWS Solutions Architect",
      "AWS Developer Associate",
      "Google Cloud Professional",
      "Azure Solutions Architect",
      "Kubernetes Administrator (CKA)",
      "Certified Scrum Master (CSM)",
      "PMP Certification",
      "CISSP",
      "Terraform Associate",
      "Docker Certified Associate",
    ],
    Business: [
      "Six Sigma Black Belt",
      "PMP Certification",
      "MBA",
      "CFA Charterholder",
      "CPA Certification",
      "SHRM-CP",
      "Lean Certification",
      "Change Management Certification",
    ],
    Health: [
      "ACE Certified Personal Trainer",
      "Registered Dietitian (RD)",
      "Certified Health Coach",
      "CPR/AED Certification",
      "Yoga Alliance RYT-200",
      "NASM Certified",
    ],
    Education: [
      "TESOL Certification",
      "Teaching License",
      "Instructional Design Certificate",
      "EdTech Certification",
      "Curriculum Development Certificate",
    ],
    "Creative Arts": [
      "Adobe Certified Expert",
      "UX Design Certificate",
      "Google UX Design",
      "Interaction Design Foundation",
      "HCD Certification",
    ],
    "Personal Development": [
      "ICF Certified Coach (ACC/PCC/MCC)",
      "Life Coaching Certification",
      "NLP Practitioner",
      "Executive Coaching Certificate",
      "Leadership Development Certificate",
    ],
  };

  const certs = certsByDomain[domain] || certsByDomain["Technology"];
  return faker.helpers.arrayElement(certs);
}

/**
 * Generate issuing organizations for certifications
 */
export function generateIssuingOrganization(certName: string): string {
  const orgMap: Record<string, string> = {
    AWS: "Amazon Web Services",
    Google: "Google Cloud",
    Azure: "Microsoft",
    Kubernetes: "Cloud Native Computing Foundation",
    Scrum: "Scrum Alliance",
    PMP: "Project Management Institute",
    CISSP: "ISC2",
    Terraform: "HashiCorp",
    Docker: "Docker Inc.",
    "Six Sigma": "ASQ",
    CFA: "CFA Institute",
    CPA: "AICPA",
    SHRM: "SHRM",
    ACE: "American Council on Exercise",
    NASM: "National Academy of Sports Medicine",
    Yoga: "Yoga Alliance",
    TESOL: "TESOL International Association",
    Adobe: "Adobe Inc.",
    ICF: "International Coaching Federation",
    NLP: "NLP Association",
  };

  for (const [key, org] of Object.entries(orgMap)) {
    if (certName.includes(key)) {
      return org;
    }
  }
  return faker.company.name();
}

/**
 * Generate universities/institutions
 */
export function generateInstitution(): string {
  const institutions = [
    "Stanford University",
    "MIT",
    "Harvard University",
    "UC Berkeley",
    "Carnegie Mellon University",
    "University of Michigan",
    "Georgia Tech",
    "University of Texas at Austin",
    "University of Washington",
    "Columbia University",
    "NYU",
    "UCLA",
    "University of Chicago",
    "Northwestern University",
    "Duke University",
    "University of Pennsylvania",
    "Cornell University",
    "Yale University",
    "Princeton University",
    "University of Illinois",
    "University of Toronto",
    "Oxford University",
    "Cambridge University",
    "Imperial College London",
    "ETH Zurich",
    "National University of Singapore",
    "IIT Delhi",
    "IIT Bombay",
    faker.company.name() + " University",
  ];
  return faker.helpers.arrayElement(institutions);
}

/**
 * Generate degree types
 */
export function generateDegree(): string {
  const degrees = [
    "Bachelor of Science",
    "Bachelor of Arts",
    "Bachelor of Engineering",
    "Bachelor of Business Administration",
    "Master of Science",
    "Master of Business Administration",
    "Master of Engineering",
    "Master of Arts",
    "Doctor of Philosophy",
    "Associate Degree",
  ];
  return faker.helpers.arrayElement(degrees);
}

/**
 * Generate field of study based on domain
 */
export function generateFieldOfStudy(domain: string): string {
  const fieldsByDomain: Record<string, string[]> = {
    Technology: [
      "Computer Science",
      "Software Engineering",
      "Information Technology",
      "Data Science",
      "Electrical Engineering",
      "Computer Engineering",
      "Cybersecurity",
      "Artificial Intelligence",
    ],
    Business: [
      "Business Administration",
      "Finance",
      "Marketing",
      "Economics",
      "Management",
      "Accounting",
      "Operations Management",
      "International Business",
    ],
    Health: [
      "Public Health",
      "Nutrition",
      "Kinesiology",
      "Health Sciences",
      "Psychology",
      "Nursing",
      "Physical Therapy",
    ],
    Education: [
      "Education",
      "Educational Psychology",
      "Curriculum Development",
      "Special Education",
      "Educational Technology",
      "Teaching",
    ],
    "Creative Arts": [
      "Graphic Design",
      "Fine Arts",
      "Digital Media",
      "Visual Communication",
      "Interactive Design",
      "Film Studies",
    ],
    "Personal Development": [
      "Psychology",
      "Counseling",
      "Organizational Development",
      "Human Resources",
      "Leadership Studies",
    ],
  };

  const fields = fieldsByDomain[domain] || fieldsByDomain["Technology"];
  return faker.helpers.arrayElement(fields);
}

/**
 * Generate countries
 */
export function generateCountry(): string {
  const countries = [
    "United States",
    "Canada",
    "United Kingdom",
    "Germany",
    "France",
    "Australia",
    "India",
    "Singapore",
    "Japan",
    "Netherlands",
    "Sweden",
    "Switzerland",
    "Ireland",
    "Brazil",
    "Mexico",
    "UAE",
    "South Korea",
    "Spain",
    "Italy",
    "New Zealand",
  ];
  return faker.helpers.arrayElement(countries);
}

/**
 * Generate cities based on country
 */
export function generateCity(country: string): string {
  const citiesByCountry: Record<string, string[]> = {
    "United States": [
      "San Francisco",
      "New York",
      "Seattle",
      "Austin",
      "Boston",
      "Los Angeles",
      "Chicago",
      "Denver",
      "Portland",
      "Miami",
    ],
    Canada: ["Toronto", "Vancouver", "Montreal", "Calgary", "Ottawa"],
    "United Kingdom": ["London", "Manchester", "Edinburgh", "Bristol", "Leeds"],
    Germany: ["Berlin", "Munich", "Frankfurt", "Hamburg", "Cologne"],
    France: ["Paris", "Lyon", "Marseille", "Toulouse", "Nice"],
    Australia: ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide"],
    India: [
      "Bangalore",
      "Mumbai",
      "Delhi",
      "Hyderabad",
      "Chennai",
      "Pune",
      "Kolkata",
    ],
    Singapore: ["Singapore"],
    Japan: ["Tokyo", "Osaka", "Kyoto", "Yokohama", "Nagoya"],
    Netherlands: ["Amsterdam", "Rotterdam", "The Hague", "Utrecht"],
    Sweden: ["Stockholm", "Gothenburg", "Malmo"],
    Switzerland: ["Zurich", "Geneva", "Basel", "Bern"],
    Ireland: ["Dublin", "Cork", "Galway"],
    Brazil: ["Sao Paulo", "Rio de Janeiro", "Brasilia"],
    Mexico: ["Mexico City", "Guadalajara", "Monterrey"],
    UAE: ["Dubai", "Abu Dhabi"],
    "South Korea": ["Seoul", "Busan", "Incheon"],
    Spain: ["Madrid", "Barcelona", "Valencia"],
    Italy: ["Milan", "Rome", "Florence"],
    "New Zealand": ["Auckland", "Wellington", "Christchurch"],
  };

  const cities = citiesByCountry[country] || ["Unknown City"];
  return faker.helpers.arrayElement(cities);
}

/**
 * Generate admin access scope JSON
 */
export function generateAccessScope(adminLevel: string): object {
  const baseScope = {
    users: { read: true, write: false, delete: false },
    content: { read: true, write: false, delete: false },
    analytics: { read: true, write: false, delete: false },
    settings: { read: false, write: false, delete: false },
    billing: { read: false, write: false, delete: false },
  };

  switch (adminLevel) {
    case "SUPER_ADMIN":
      return {
        users: { read: true, write: true, delete: true },
        content: { read: true, write: true, delete: true },
        analytics: { read: true, write: true, delete: true },
        settings: { read: true, write: true, delete: true },
        billing: { read: true, write: true, delete: true },
        system: { read: true, write: true, delete: true },
      };
    case "ADMIN":
      return {
        users: { read: true, write: true, delete: false },
        content: { read: true, write: true, delete: true },
        analytics: { read: true, write: true, delete: false },
        settings: { read: true, write: true, delete: false },
        billing: { read: true, write: false, delete: false },
      };
    case "MODERATOR":
      return baseScope;
    default:
      return baseScope;
  }
}

/**
 * Generate assigned regions for admins
 */
export function generateAssignedRegions(): string[] {
  const regions = [
    "North America",
    "Europe",
    "Asia Pacific",
    "Latin America",
    "Middle East",
    "Africa",
    "South Asia",
    "Southeast Asia",
    "Australia & NZ",
    "Global",
  ];
  const count = faker.number.int({ min: 1, max: 3 });
  return faker.helpers.arrayElements(regions, count);
}
