import { ImageType } from "@/hooks/useImages";
import { renderImage } from "@/lib/image";

export default function UnlockPotentialSection({
  images,
}: {
  images: ImageType[];
}) {
  return (
    <section
      id="benefits"
      className="w-full py-16 md:py-24 lg:py-32 bg-gray-100"
    >
      <div className="container mx-auto px-4 md:px-6">
        <div className="flex flex-col items-center justify-center space-y-6 text-center">
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tighter">
            Unlock Your Full Potential
          </h2>
          <p className="max-w-[900px] text-lg text-gray-600 md:text-xl">
            Experience transformative growth with our comprehensive mentorship
            program.
          </p>
        </div>
        <div className="grid lg:grid-cols-2 gap-12 mt-12">
          <div className="flex flex-col justify-center space-y-6">
            <ul className="space-y-6">
              <li>
                <h3 className="text-xl font-bold">
                  Tailored Career Acceleration
                </h3>
                <p className="text-gray-600">
                  Receive a personalized roadmap to fast-track your career
                  goals, designed by industry experts who've walked the path.
                </p>
              </li>
              <li>
                <h3 className="text-xl font-bold">
                  Insider Knowledge & Strategies
                </h3>
                <p className="text-gray-600">
                  Gain exclusive insights and proven strategies to navigate
                  complex career challenges and seize hidden opportunities.
                </p>
              </li>
              <li>
                <h3 className="text-xl font-bold">
                  Confidence & Skill Mastery
                </h3>
                <p className="text-gray-600">
                  Develop unshakeable confidence and master critical skills
                  through hands-on guidance and real-world application.
                </p>
              </li>
            </ul>
          </div>
          <div className="flex justify-center items-center">
            {renderImage(images, 2, "/placeholder.svg", 550, 310)}
          </div>
        </div>
      </div>
    </section>
  );
}
