import { faker } from "@faker-js/faker";
import {
  User,
  UserRole,
  ConsultantProfile,
  ConsulteeProfile,
  StaffProfile,
  ScheduleType,
  ConsultationMode,
  PlanEmailSupport,
  Domain,
  SubDomain,
  Tag,
} from "@prisma/client";
import prisma from "../../lib/prisma";

export type UserWithProfiles = User & {
  consultantProfile?: ConsultantProfile | null;
  consulteeProfile?: ConsulteeProfile | null;
  staffProfile?: StaffProfile | null;
};

const NUM_USERS = 100;
const NUM_CONSULTANTS = 40;
const NUM_CONSULTEES = 60;

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

  return {
    rating: faker.number.float({ min: 1, max: 5, multipleOf: 0.1 }),
    specialization: faker.person.jobArea(),
    experience: faker.helpers.arrayElement([
      "1-3 years",
      "3-5 years",
      "5-10 years",
      "10+ years",
    ]),
    description: faker.lorem.paragraph(),
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
    qualifications: faker.lorem.sentence(),
  };
}

export async function createUsers(): Promise<UserWithProfiles[]> {
  await createDomainsSubdomainsTags();

  const users: UserWithProfiles[] = [];
  console.log(`Creating ${NUM_USERS} users...`);
  for (let i = 0; i < NUM_USERS; i++) {
    const userRole: UserRole =
      i < NUM_CONSULTANTS
        ? "CONSULTANT"
        : i < NUM_CONSULTEES + NUM_CONSULTANTS
          ? "CONSULTEE"
          : "STAFF";
    try {
      const user = await prisma.user.create({
        data: {
          name: faker.person.fullName(),
          email: faker.internet.email(),
          emailVerified: faker.date.past(),
          image: faker.image.avatar(),
          phone: faker.phone.number(),
          address: faker.location.streetAddress(),
          onlineStatus: faker.datatype.boolean(),
          currentTimezone: faker.location.timeZone(),
          onboardingCompleted: faker.datatype.boolean(),
          role: userRole,
          cookiePreferences: {
            create: {
              essential: true,
              analytics: faker.datatype.boolean(),
              marketing: faker.datatype.boolean(),
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
          ...(userRole === "CONSULTANT" && {
            consultantProfile: {
              create: await createConsultantProfileData(),
            },
          }),
          ...(userRole === "CONSULTEE" && {
            consulteeProfile: {
              create: {
                education: faker.helpers.arrayElement([
                  "High School",
                  "Bachelor's",
                  "Master's",
                  "PhD",
                ]),
                occupation: faker.person.jobTitle(),
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
                specialRequirements: faker.lorem.sentence(),
                interests: faker.lorem.words(5),
                aboutMe: faker.lorem.paragraph(),
                goals: faker.lorem.sentence(),
              },
            },
          }),
          ...(userRole === "STAFF" && {
            staffProfile: {
              create: {
                department: faker.commerce.department(),
                position: faker.person.jobTitle(),
                permissions: {
                  permissions: faker.helpers.arrayElements(
                    ["read", "write", "delete"],
                    { min: 1, max: 3 },
                  ),
                },
                responsibilities: {
                  responsibilities: faker.helpers.arrayElements(
                    [
                      "manage team",
                      "oversee projects",
                      "allocate resources",
                      "budget",
                    ],
                    { min: 1, max: 4 },
                  ),
                },
              },
            },
          }),
        },
        include: {
          consultantProfile: true,
          consulteeProfile: true,
          staffProfile: true,
        },
      });
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
