import { faker } from "@faker-js/faker";
import {
  AdminLevel,
  AdminProfile,
  BudgetPreference,
  CareerStage,
  ConsultantProfile,
  ConsultationMode,
  ConsulteeProfile,
  Gender,
  ScheduleType,
  SessionType,
  StaffProfile,
  User,
  UserRole,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  sanitizeEmail,
  sanitizePhone,
  sanitizeString,
  generateDateOfBirth,
  generateBio,
  generateHeadline,
  generateLanguages,
  generateToolsAndTechnologies,
  generateMentoringStyle,
  generateSkillsToDevelop,
  generateIndustry,
  generateStaffSkills,
  generateWorkSchedule,
  generateCountry,
  generateCity,
  generateCompanyName,
  generateAccessScope,
  generateAssignedRegions,
} from "./utils";
import { config } from "./config";

export type UserWithProfiles = User & {
  consultantProfile?: ConsultantProfile | null;
  consulteeProfile?: ConsulteeProfile | null;
  staffProfile?: StaffProfile | null;
  adminProfile?: AdminProfile | null;
};

// User distribution - configurable via SEED_MODE environment variable
const NUM_CONSULTANTS = config.volumes.users.consultants;
const NUM_CONSULTEES = config.volumes.users.consultees;
const NUM_STAFF = config.volumes.users.staff;
const NUM_ADMINS = config.volumes.users.admins;
const NUM_USERS = NUM_CONSULTANTS + NUM_CONSULTEES + NUM_STAFF + NUM_ADMINS;

// Gender enum values
const GENDERS: Gender[] = ["MALE", "FEMALE", "NON_BINARY", "PREFER_NOT_TO_SAY"];

// Career stage enum values
const CAREER_STAGES: CareerStage[] = [
  "STUDENT",
  "EARLY_CAREER",
  "MID_CAREER",
  "SENIOR",
  "EXECUTIVE",
];

// Budget preference enum values
const BUDGET_PREFERENCES: BudgetPreference[] = [
  "BUDGET",
  "MODERATE",
  "PREMIUM",
  "FLEXIBLE",
];

// Session type enum values
const SESSION_TYPES: SessionType[] = ["ONE_ON_ONE", "GROUP", "ASYNC_REVIEW"];

// Admin level enum values
const ADMIN_LEVELS: AdminLevel[] = ["SUPER_ADMIN", "ADMIN", "MODERATOR"];

// Predefined domains, subdomains, and tags
const domains = [
  {
    name: "Technology",
    subdomains: [
      "Web Development",
      "Mobile Development",
      "Data Science",
      "Cloud Computing",
      "Cybersecurity",
      "DevOps",
      "Artificial Intelligence",
      "Blockchain",
    ],
    tags: [
      "JavaScript",
      "Python",
      "React",
      "Machine Learning",
      "AWS",
      "Docker",
      "Kubernetes",
      "Node.js",
      "TypeScript",
      "Angular",
      "Vue.js",
      "TensorFlow",
      "Cyber Defense",
      "Cloud Architecture",
      "Smart Contracts",
    ],
  },

  {
    name: "Business",
    subdomains: [
      "Marketing",
      "Finance",
      "Management",
      "Entrepreneurship",
      "Sales",
      "Operations",
      "Human Resources",
      "Strategy",
      "Supply Chain",
    ],
    tags: [
      "Digital Marketing",
      "Financial Planning",
      "Leadership",
      "Business Analytics",
      "Project Management",
      "Risk Management",
      "Strategic Planning",
      "Brand Development",
      "Market Research",
      "Investment Strategy",
      "Team Building",
      "Change Management",
    ],
  },

  {
    name: "Health",
    subdomains: [
      "Nutrition",
      "Fitness",
      "Mental Health",
      "Preventive Care",
      "Physical Therapy",
      "Sports Medicine",
      "Holistic Health",
      "Wellness Coaching",
    ],
    tags: [
      "Diet",
      "Yoga",
      "Meditation",
      "Stress Management",
      "Exercise Science",
      "Mindfulness",
      "Sports Performance",
      "Injury Prevention",
      "Healthy Lifestyle",
      "Weight Management",
      "Mental Wellness",
    ],
  },

  {
    name: "Education",
    subdomains: [
      "K-12 Education",
      "Higher Education",
      "Special Education",
      "Online Learning",
      "Educational Technology",
      "Curriculum Development",
    ],
    tags: [
      "Teaching Methods",
      "E-Learning",
      "Educational Psychology",
      "Instructional Design",
      "Student Assessment",
      "Learning Management Systems",
      "STEM Education",
    ],
  },

  {
    name: "Creative Arts",
    subdomains: [
      "Graphic Design",
      "Digital Art",
      "Photography",
      "Video Production",
      "Animation",
      "UI/UX Design",
    ],
    tags: [
      "Adobe Creative Suite",
      "Visual Design",
      "Motion Graphics",
      "Color Theory",
      "Typography",
      "Digital Photography",
      "Video Editing",
      "User Interface Design",
    ],
  },

  {
    name: "Personal Development",
    subdomains: [
      "Career Coaching",
      "Life Coaching",
      "Communication Skills",
      "Time Management",
      "Personal Finance",
    ],
    tags: [
      "Goal Setting",
      "Public Speaking",
      "Emotional Intelligence",
      "Productivity",
      "Work-Life Balance",
      "Personal Branding",
      "Networking Skills",
    ],
  },
];

async function createDomainsSubdomainsTags() {
  for (const domain of domains) {
    const createdDomain = await prisma.domain.create({
      data: {
        name: domain.name,
        subDomains: {
          create: domain.subdomains.map((sd) => ({ name: sd })),
        },
        tags: {
          create: domain.tags.map((t) => ({ name: t })),
        },
      },
    });
    console.log(`Created domain: ${createdDomain.name}`);
  }
}

async function createConsultantProfileData() {
  // Get all domains with their subdomains and tags
  const allDomains = await prisma.domain.findMany({
    include: {
      subDomains: true,
      tags: true,
    },
  });

  if (allDomains.length === 0) {
    throw new Error("No domains found");
  }

  // Randomly select a domain
  const domain = faker.helpers.arrayElement(allDomains);

  const subDomains = faker.helpers.arrayElements(domain.subDomains, {
    min: 1,
    max: 2,
  });
  const tags = faker.helpers.arrayElements(domain.tags, { min: 2, max: 4 });

  // Generate experience years (1-25)
  const experience = faker.number.float({
    min: 1,
    max: 25,
    multipleOf: 0.5,
  });

  // Generate session types (at least ONE_ON_ONE, possibly more)
  const sessionTypes = faker.helpers.arrayElements(SESSION_TYPES, {
    min: 1,
    max: 3,
  });
  if (!sessionTypes.includes("ONE_ON_ONE")) {
    sessionTypes.push("ONE_ON_ONE");
  }

  // Calculate profile completion percentage based on filled fields
  const profileCompletionPercentage = faker.number.int({ min: 60, max: 100 });

  // Verified status based on experience and completion
  const isVerified =
    experience > 5 && profileCompletionPercentage > 80
      ? faker.datatype.boolean({ probability: 0.7 })
      : faker.datatype.boolean({ probability: 0.2 });

  // Total mentees helped
  const totalMenteesHelped = Math.floor(
    experience * faker.number.int({ min: 5, max: 20 }),
  );

  return {
    rating: faker.number.float({ min: 3.5, max: 5, multipleOf: 0.1 }),
    experience,
    description: sanitizeString(faker.lorem.paragraph()),
    domain: { connect: { id: domain.id } },
    subDomains: {
      connect: subDomains.map((sd) => ({ id: sd.id })),
    },
    tags: {
      connect: tags.map((t) => ({ id: t.id })),
    },
    scheduleType: faker.helpers.arrayElement([
      "WEEKLY",
      "CUSTOM",
    ]) as ScheduleType,

    // Consultant profile fields
    headline: generateHeadline(domain.name),
    websiteUrl: faker.datatype.boolean({ probability: 0.6 })
      ? faker.internet.url()
      : null,
    twitterUrl: faker.datatype.boolean({ probability: 0.5 })
      ? `https://twitter.com/${faker.internet.username()}`
      : null,
    githubUrl: faker.datatype.boolean({ probability: 0.4 })
      ? `https://github.com/${faker.internet.username()}`
      : null,
    videoIntroUrl: faker.datatype.boolean({ probability: 0.3 })
      ? `https://youtube.com/watch?v=${faker.string.alphanumeric(11)}`
      : null,
    languages: generateLanguages(),
    toolsAndTechnologies: generateToolsAndTechnologies(domain.name),
    mentoringStyle: generateMentoringStyle(),
    sessionTypes,
    profileCompletionPercentage,
    isVerified,
    totalMenteesHelped,
    domainName: domain.name, // For passing to work experience generation
  };
}

function createConsulteeProfileData() {
  const careerStage = faker.helpers.arrayElement(CAREER_STAGES);
  const budgetPreference = faker.helpers.arrayElement(BUDGET_PREFERENCES);

  return {
    occupation: sanitizeString(faker.person.jobTitle()),
    preferredCommunicationMethod: faker.helpers.arrayElement([
      ConsultationMode.VIDEO,
      ConsultationMode.AUDIO,
      ConsultationMode.IN_PERSON,
    ]),
    preferredLanguage: faker.helpers.arrayElement([
      "English",
      "Spanish",
      "French",
      "German",
      "Chinese",
    ]),
    aboutMe: sanitizeString(faker.lorem.paragraph()),
    goals: sanitizeString(faker.lorem.sentence()),

    // Enhanced consultee profile fields
    careerStage,
    currentCompany: faker.datatype.boolean({ probability: 0.7 })
      ? generateCompanyName()
      : null,
    industry: generateIndustry(),
    skillsToDevelop: generateSkillsToDevelop(),
    linkedinUrl: faker.datatype.boolean({ probability: 0.6 })
      ? `https://linkedin.com/in/${faker.internet.username()}`
      : null,
    budgetPreference,
  };
}

function createStaffProfileData(staffIndex: number, managerIds: string[]) {
  const departments = [
    "Customer Support",
    "Operations",
    "Quality Assurance",
    "Content Moderation",
    "Training",
  ];
  const positions = [
    "Support Specialist",
    "Operations Coordinator",
    "QA Analyst",
    "Content Moderator",
    "Training Coordinator",
    "Team Lead",
  ];

  // First staff member has no manager, subsequent ones report to earlier staff
  const reportsTo =
    staffIndex > 0 && managerIds.length > 0
      ? faker.helpers.arrayElement(managerIds)
      : null;

  return {
    department: faker.helpers.arrayElement(departments),
    position: faker.helpers.arrayElement(positions),
    permissions: {
      permissions: faker.helpers.arrayElements(["read", "write", "delete"], {
        min: 1,
        max: 3,
      }),
    },
    responsibilities: {
      responsibilities: faker.helpers.arrayElements(
        ["manage team", "oversee projects", "allocate resources", "budget"],
        { min: 1, max: 4 },
      ),
    },

    // New fields for enhanced staff profile
    employeeId: `EMP-${faker.string.alphanumeric(6).toUpperCase()}`,
    hireDate: faker.date.past({ years: 3 }),
    reportsTo,
    skills: generateStaffSkills(),
    workSchedule: generateWorkSchedule(),
  };
}

function createAdminProfileData(adminIndex: number): {
  adminLevel: AdminLevel;
  accessScope: object;
  assignedRegions: string[];
  notes: string | null;
} {
  // First admin is SUPER_ADMIN, rest are distributed
  let adminLevel: AdminLevel;
  if (adminIndex === 0) {
    adminLevel = "SUPER_ADMIN";
  } else if (adminIndex === 1) {
    adminLevel = "ADMIN";
  } else {
    adminLevel = faker.helpers.arrayElement(ADMIN_LEVELS);
  }

  return {
    adminLevel,
    accessScope: generateAccessScope(adminLevel),
    assignedRegions:
      adminLevel === "SUPER_ADMIN" ? ["Global"] : generateAssignedRegions(),
    notes: faker.datatype.boolean({ probability: 0.3 })
      ? sanitizeString(faker.lorem.paragraph())
      : null,
  };
}

export async function createUsers(): Promise<UserWithProfiles[]> {
  await createDomainsSubdomainsTags();

  const users: UserWithProfiles[] = [];
  const staffUserIds: string[] = []; // Track staff user IDs for reportsTo
  let consultantIndex = 0;
  let consulteeIndex = 0;
  let staffIndex = 0;
  let adminIndex = 0;

  console.log(`Creating ${NUM_USERS} users...`);
  console.log(`  - ${NUM_CONSULTANTS} consultants`);
  console.log(`  - ${NUM_CONSULTEES} consultees`);
  console.log(`  - ${NUM_STAFF} staff members`);
  console.log(`  - ${NUM_ADMINS} admins`);

  for (let i = 0; i < NUM_USERS; i++) {
    // Determine user role based on index
    let userRole: UserRole;
    if (consultantIndex < NUM_CONSULTANTS) {
      userRole = "CONSULTANT";
      consultantIndex++;
    } else if (consulteeIndex < NUM_CONSULTEES) {
      userRole = "CONSULTEE";
      consulteeIndex++;
    } else if (staffIndex < NUM_STAFF) {
      userRole = "STAFF";
      staffIndex++;
    } else {
      userRole = "ADMIN";
      adminIndex++;
    }

    try {
      // Generate common user fields
      const country = generateCountry();
      const city = generateCity(country);
      const gender = faker.helpers.arrayElement(GENDERS);

      const userData: any = {
        name: sanitizeString(faker.person.fullName()),
        email: sanitizeEmail(faker.internet.email()),
        emailVerified: faker.date.past(),
        image: sanitizeString(faker.image.avatar()),
        phone: sanitizePhone(faker.phone.number()),
        address: sanitizeString(faker.location.streetAddress()),
        onlineStatus: faker.datatype.boolean(),
        timezone: sanitizeString(faker.location.timeZone()),
        onboardingCompleted: faker.datatype.boolean(),
        role: userRole,

        // New fields for enhanced user
        dateOfBirth: faker.datatype.boolean({ probability: 0.8 })
          ? generateDateOfBirth()
          : null,
        gender,
        city,
        country,
        linkedinUrl: faker.datatype.boolean({ probability: 0.5 })
          ? `https://linkedin.com/in/${faker.internet.username()}`
          : null,
        bio: faker.datatype.boolean({ probability: 0.7 })
          ? generateBio()
          : null,

        cookiePreferences: {
          create: {
            essential: true,
            analytics: faker.datatype.boolean(),
            marketing: faker.datatype.boolean(),
            functional: faker.datatype.boolean(),
          },
        },
        notificationPreferences: {
          create: {
            allNotifications: faker.datatype.boolean(),
            mentions: faker.datatype.boolean(),
            directMessages: faker.datatype.boolean(),
            updates: faker.datatype.boolean(),
          },
        },
      };

      // Add role-specific profile
      if (userRole === "CONSULTANT") {
        const consultantData = await createConsultantProfileData();
        // Remove the domainName property before passing to Prisma
        const { domainName, ...consultantProfileData } = consultantData;
        userData.consultantProfile = {
          create: consultantProfileData,
        };
      } else if (userRole === "CONSULTEE") {
        userData.consulteeProfile = {
          create: createConsulteeProfileData(),
        };
      } else if (userRole === "STAFF") {
        userData.staffProfile = {
          create: createStaffProfileData(staffIndex - 1, staffUserIds),
        };
      } else if (userRole === "ADMIN") {
        userData.adminProfile = {
          create: createAdminProfileData(adminIndex - 1),
        };
      }

      const user = await prisma.user.create({
        data: userData,
        include: {
          consultantProfile: true,
          consulteeProfile: true,
          staffProfile: true,
          adminProfile: true,
        },
      });

      // Track staff IDs for reportsTo relationships
      if (userRole === "STAFF") {
        staffUserIds.push(user.id);
      }

      users.push(user);
    } catch (error) {
      console.error("Failed to create user:", error);
    }
    if ((i + 1) % 10 === 0) {
      console.log(`Created ${i + 1} users`);
    }
  }
  console.log(`Created ${users.length} users successfully.`);
  return users;
}
