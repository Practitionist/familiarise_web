import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";

const TEAM_MEMBERS = [
  {
    name: "John Doe",
    role: "CEO",
    description:
      "John is the visionary behind our company, leading the team to new heights.",
  },
  {
    name: "Jane Appleseed",
    role: "CTO",
    description:
      "Jane leads our engineering team, ensuring our products are cutting-edge and reliable.",
  },
  {
    name: "Kara Sato",
    role: "Head of Design",
    description:
      "Kara leads our design team, ensuring our products have a beautiful and intuitive user experience.",
  },
  {
    name: "Michael Reeves",
    role: "Head of Marketing",
    description:
      "Michael leads our marketing efforts, ensuring our brand resonates with our target audience.",
  },
  {
    name: "Lisa Simmons",
    role: "Head of Sales",
    description:
      "Lisa leads our sales team, ensuring our customers receive top-notch service.",
  },
  {
    name: "John Bauer",
    role: "Head of Customer Support",
    description:
      "John leads our customer support team, ensuring our customers have a seamless experience.",
  },
  {
    name: "Sarah Mayer",
    role: "Head of Human Resources",
    description:
      "Sarah leads our HR team, ensuring our employees have the support they need to thrive.",
  },
  {
    name: "David Wong",
    role: "Head of Finance",
    description:
      "David leads our finance team, ensuring our company remains financially sound.",
  },
];

export default function MeetTheTeam() {
  return (
    <section className="w-full py-16 md:py-24 lg:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tighter mb-4">
            Meet the Team
          </h2>
          <p className="text-lg text-gray-600 md:text-xl max-w-[700px] mx-auto">
            Get to know the talented individuals behind our company.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
          {TEAM_MEMBERS.map((member, index) => (
            <div
              key={index}
              className="flex flex-col items-center justify-center space-y-4 rounded-lg bg-white p-6 shadow-lg transition-transform duration-300 hover:-translate-y-2 hover:shadow-xl"
            >
              <Avatar className="w-24 h-24">
                <AvatarImage src={`/placeholder-user-${index + 1}.jpg`} />
                <AvatarFallback>
                  {member.name
                    .split(" ")
                    .map((n) => n[0])
                    .join("")}
                </AvatarFallback>
              </Avatar>
              <div className="space-y-2 text-center">
                <h4 className="text-xl font-semibold">{member.name}</h4>
                <p className="text-sm text-gray-600">{member.role}</p>
                <p className="text-sm text-gray-600">{member.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
