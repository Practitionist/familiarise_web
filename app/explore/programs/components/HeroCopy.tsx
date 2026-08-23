import { Sparkles } from "lucide-react";

/** Static hero copy shared by ProgramsInteractiveContent's hero and
 *  ProgramsExploreSkeleton (the loading state), so the skeleton renders real
 *  text (skeletons cannot fire FCP, #1102) without duplicating the markup. */
export function ProgramsHeroCopy() {
  return (
    <>
      <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-800/50 backdrop-blur-sm border border-zinc-700/50 rounded-full mb-8">
        <Sparkles className="w-4 h-4 text-white" />
        <span className="text-sm font-medium text-zinc-300">
          Learn from the Best
        </span>
      </div>

      <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6">
        Classes & <span className="silver-text">Webinars</span>
      </h1>

      <p className="text-lg md:text-xl text-zinc-400 mb-12 max-w-2xl mx-auto">
        Expand your knowledge with expert-led classes and live webinars. Learn
        at your own pace or join interactive sessions.
      </p>
    </>
  );
}
