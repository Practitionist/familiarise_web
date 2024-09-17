import { faker } from "@faker-js/faker";
import {
  User,
  UserRole,
  ConsultantProfile,
  ConsulteeProfile,
  StaffProfile,
  ScheduleType,
  ConsultationMode,
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

export async function createUsers(): Promise<UserWithProfiles[]> {
  const users: UserWithProfiles[] = [];
  console.log(`Creating ${NUM_USERS} users...`);
  for (let i = 0; i < NUM_USERS; i++) {
    const userRole: UserRole = i < NUM_CONSULTANTS ? "CONSULTANT" : (i < NUM_CONSULTEES + NUM_CONSULTANTS ? "CONSULTEE" : "STAFF");
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
              create: {
                rating: faker.number.float({ min: 1, max: 5, multipleOf: 0.1 }),
                specialization: faker.person.jobArea(),
                experience: faker.helpers.arrayElement([
                  "1-3 years",
                  "3-5 years",
                  "5-10 years",
                  "10+ years",
                ]),
                location: faker.location.city(),
                description: faker.lorem.paragraph(),
                tags: faker.helpers.arrayElements(
                  ["Expert", "Certified", "Top Rated", "Experienced"],
                  { min: 1, max: 3 }
                ),
                domain: faker.person.jobType(),
                subDomains: faker.helpers.arrayElements(
                  [
                    "Risk Management",
                    "Training",
                    "Digital Marketing",
                    "Data Analysis",
                    "Supply Chain",
                  ],
                  { min: 1, max: 3 }
                ),
                scheduleType: faker.helpers.arrayElement([
                  "WEEKLY",
                  "CUSTOM",
                ]) as ScheduleType,
              },
            },
          }),
          ...(userRole === "CONSULTEE" && {
            consulteeProfile: {
              create: {
                education: faker.helpers.arrayElement(['High School', 'Bachelor\'s', 'Master\'s', 'PhD']),
                occupation: faker.person.jobTitle(),
                preferredCommunicationMethod: faker.helpers.arrayElement([
                  ConsultationMode.VIDEO,
                  ConsultationMode.AUDIO,
                  ConsultationMode.IN_PERSON,
                ]),
                preferredLanguage: faker.helpers.arrayElement(['English', 'Spanish', 'French', 'German', 'Chinese']),
                specialRequirements: faker.lorem.sentence(),
                interests: faker.helpers.arrayElements(
                  ['Technology', 'Finance', 'Healthcare', 'Education', 'Marketing', 'Sports', 'Entertainment', 'Travel', 'Fashion', 'Food', 'Music', 'Art', 'Science', 'Environment', 'Politics', 'History', 'Culture', 'Books', 'Movies', 'TV Shows', 'Gaming', 'Fitness', 'Pets', 'Cars', 'DIY', 'Home Decor', 'Gardening', 'Photography', 'Writing', 'Social Media', 'Mental Health', 'Parenting', 'Relationships', 'Self Improvement', 'Spirituality', 'Philosophy', 'Sustainability', 'Human Rights', 'Charity', 'Volunteering', 'Hobbies', 'Cooking', 'Baking', 'Dancing', 'Singing', 'Acting', 'Crafts', 'Yoga', 'Meditation', 'Astrology', 'Tarot', 'Horoscopes', 'Mythology', 'Folklore', 'Urban Legends', 'Conspiracy Theories', 'True Crime', 'Paranormal', 'Aliens', 'Cryptocurrency', 'Blockchain', 'Investing', 'Trading', 'Real Estate', 'Entrepreneurship', 'Startups', 'Business', 'Management', 'Leadership', 'Sales', 'Customer Service', 'Human Resources'],
                  { min: 1, max: 3 }
                ).join(', '),
              },
            },
          }),
          ...(userRole === "STAFF" && {
            staffProfile: {
              create: {
                department: faker.commerce.department(),
                position: faker.person.jobTitle(),
                permissions: { permissions: faker.helpers.arrayElements(['read', 'write', 'delete'], { min: 1, max: 3 }) },
                responsibilities: { responsibilities: faker.helpers.arrayElements(['manage team', 'oversee projects', 'allocate resources', 'budget'], { min: 1, max: 4 }) }
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
