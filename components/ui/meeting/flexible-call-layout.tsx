'use client';

import {
  CallControls,
  PaginatedGridLayout,
  SpeakerLayout,
} from "@stream-io/video-react-sdk";
import {
  BetweenHorizonalEnd,
  BetweenVerticalEnd,
  LayoutGrid,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import EndCallButton from "./end-call-button";

type CallLayout = "speaker-vert" | "speaker-horiz" | "grid";

export default function FlexibleCallLayout() {
  const [layout, setLayout] = useState<CallLayout>("speaker-vert");
  const router = useRouter();

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-center py-2">
        <CallLayoutButtons layout={layout} setLayout={setLayout} />
      </div>
      <div className="flex-1 min-h-0 relative">
        <div className="absolute inset-0 bg-gray-900 rounded-lg overflow-hidden">
          <div className="w-full h-full flex">
            <CallLayoutView layout={layout} />
          </div>
        </div>
      </div>
      <div className="flex flex-col items-center gap-2 py-2">
        <CallControls onLeave={() => router.back()} />
        <EndCallButton />
      </div>
    </div>
  );
}

interface CallLayoutButtonsProps {
  layout: CallLayout;
  setLayout: (layout: CallLayout) => void;
}

function CallLayoutButtons({ layout, setLayout }: CallLayoutButtonsProps) {
  return (
    <div className="mx-auto w-fit space-x-6">
      <button onClick={() => setLayout("speaker-vert")}>
        <BetweenVerticalEnd
          className={layout !== "speaker-vert" ? "text-gray-400" : ""}
        />
      </button>
      <button onClick={() => setLayout("speaker-horiz")}>
        <BetweenHorizonalEnd
          className={layout !== "speaker-horiz" ? "text-gray-400" : ""}
        />
      </button>
      <button onClick={() => setLayout("grid")}>
        <LayoutGrid className={layout !== "grid" ? "text-gray-400" : ""} />
      </button>
    </div>
  );
}

interface CallLayoutViewProps {
  layout: CallLayout;
}

function CallLayoutView({ layout }: Readonly<CallLayoutViewProps>) {
  const commonProps = {
    mirrorLocalParticipantVideo: true,
    pageArrowsVisible: true,
  };

  const containerClass = "flex-1 relative";
  const layoutClass = "absolute inset-0";

  switch (layout) {
    case "speaker-vert":
      return (
        <div className={containerClass}>
          <div className={layoutClass}>
            <SpeakerLayout 
              {...commonProps}
              participantsBarPosition="bottom"
              participantsBarLimit="dynamic"
            />
          </div>
        </div>
      );

    case "speaker-horiz":
      return (
        <div className={containerClass}>
          <div className={layoutClass}>
            <SpeakerLayout 
              {...commonProps}
              participantsBarPosition="right"
              participantsBarLimit="dynamic"
            />
          </div>
        </div>
      );

    case "grid":
      return (
        <div className={containerClass}>
          <div className={layoutClass}>
            <PaginatedGridLayout 
              {...commonProps}
              groupSize={4}
            />
          </div>
        </div>
      );

    default:
      return null;
  }
}
