import type { ProcessFlowStepProps } from "@/components/home/flows/ProcessFlowDisplay";

export const swrOptions = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  refreshInterval: 0,
  shouldRetryOnError: true,
  errorRetryCount: 2,
  dedupingInterval: 5000,
  keepPreviousData: true,
} as const;

export const flowData: Record<string, ProcessFlowStepProps[]> = {
  consultation: [
    {
      number: 1,
      title: "Select a Consultation Plan",
      description:
        "Browse and choose from various consultation plans offered by experts",
    },
    {
      number: 2,
      title: "Create Consultation Request",
      description:
        "Submit your request with preferred time slots and specific requirements",
    },
    {
      number: 3,
      title: "Schedule Appointment",
      description:
        "Once approved, an appointment is created for your consultation",
    },
    {
      number: 4,
      title: "Complete Payment",
      description: "Secure your booking by completing the payment process",
    },
    {
      number: 5,
      title: "Join Consultation",
      description:
        "Access your consultation at the scheduled time through our platform",
      isLast: true,
    },
  ],
  subscription: [
    {
      number: 1,
      title: "Choose Subscription Plan",
      description:
        "Select from monthly subscription plans with different benefits",
    },
    {
      number: 2,
      title: "Submit Subscription Request",
      description: "Provide your preferred schedule and learning goals",
    },
    {
      number: 3,
      title: "Schedule Multiple Sessions",
      description:
        "Get access to multiple appointments throughout your subscription period",
    },
    {
      number: 4,
      title: "One-time Payment",
      description: "Make a single payment to activate your subscription",
    },
    {
      number: 5,
      title: "Access All Benefits",
      description:
        "Enjoy regular sessions and additional subscription benefits",
      isLast: true,
    },
  ],
  webinar: [
    {
      number: 1,
      title: "Select Webinar",
      description: "Choose from upcoming webinars on various topics",
    },
    {
      number: 2,
      title: "Check Availability",
      description: "View scheduled dates and remaining spots",
    },
    {
      number: 3,
      title: "Book Your Spot",
      description: "Reserve your place in the webinar",
    },
    {
      number: 4,
      title: "Complete Payment",
      description: "Secure your spot by completing the payment",
    },
    {
      number: 5,
      title: "Join Webinar",
      description: "Get access to the webinar at the scheduled time",
      isLast: true,
    },
  ],
  class: [
    {
      number: 1,
      title: "Choose Class Plan",
      description: "Browse structured class programs with detailed curricula",
    },
    {
      number: 2,
      title: "Check Class Schedule",
      description: "View class timings and batch availability",
    },
    {
      number: 3,
      title: "Secure Your Seat",
      description: "Book your place in the upcoming batch",
    },
    {
      number: 4,
      title: "Complete Payment",
      description: "Process payment to confirm your enrollment",
    },
    {
      number: 5,
      title: "Start Learning",
      description: "Access class materials and attend scheduled sessions",
      isLast: true,
    },
  ],
} as const;

export const faqItems = [
  {
    question: "What services does our consultancy provide?",
    answer:
      "We offer a range of services including business strategy, market research, and project management.",
  },
  {
    question: "How can our consultancy help your business grow?",
    answer:
      "We provide expert advice and strategies tailored to your business needs, helping you to improve efficiency and increase profits.",
  },
  {
    question: "What industries do we specialize in?",
    answer:
      "Our consultants have experience in a wide range of industries, including technology, healthcare, and finance.",
  },
  {
    question: "How can you get started with our consultancy?",
    answer:
      "Contact us to schedule a consultation. We will discuss your business needs and how our services can help you achieve your goals.",
  },
  {
    question: "What is our consultancy approach to problem-solving?",
    answer:
      "We use a collaborative approach, working closely with your team to understand your business and develop effective solutions.",
  },
] as const;