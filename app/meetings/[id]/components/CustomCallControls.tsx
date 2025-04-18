import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CallControlsProps,
  CallStats,
  CancelCallButton,
  ReactionsButton,
  RecordCallButton,
  ScreenShareButton,
  SpeakingWhileMutedNotification,
  ToggleAudioPublishingButton,
  ToggleVideoPublishingButton,
} from "@stream-io/video-react-sdk";
import { BarChart, LayoutList, Users } from "lucide-react";
import React, { useState } from "react";
import EndCallForEveryoneButton from "./EndCallForEveryoneButton";

// Define layout type locally or import if shared
type CallLayoutType = "grid" | "speaker-left" | "speaker-right";

// Extend props to include isPersonalRoom and toggleParticipantsBar
interface CustomCallControlsProps extends CallControlsProps {
  isPersonalRoom: boolean;
  toggleParticipantsBar: () => void;
  // Add setLayout if layout logic needs to affect parent, otherwise manage locally
  // setLayout: React.Dispatch<React.SetStateAction<CallLayoutType>>;
}

export const CustomCallControls: React.FC<CustomCallControlsProps> = ({
  onLeave,
  isPersonalRoom,
  toggleParticipantsBar,
  // setLayout, // Receive if needed
}) => {
  // State for layout - managed within this component now
  const [layout, setLayout] = useState<CallLayoutType>("speaker-left");
  // State for showing stats
  const [showStats, setShowStats] = useState(false);

  // Define styles consistent with other controls
  const buttonBaseClasses =
    "flex flex-col items-center text-xs text-gray-300 hover:text-white";
  const iconWrapperClasses =
    "p-2 rounded-full bg-gray-700 hover:bg-gray-600 transition-colors duration-150";
  const endCallButtonBaseClasses =
    "flex flex-col items-center text-xs text-red-400 hover:text-red-300";
  const endCallIconWrapperClasses =
    "p-2 rounded-full bg-red-800/50 hover:bg-red-700/60 transition-colors duration-150";

  // Toggle stats visibility
  const handleStatsClick = () => {
    setShowStats((prev) => !prev);
    console.log("Stats button clicked, toggling visibility");
  };

  // TODO: Add onClick handler for participants button if needed
  const handleParticipantsClick = () => {
    console.log("Participants button clicked");
    toggleParticipantsBar(); // Call the prop function
  };

  return (
    <div className="flex justify-center items-center p-1.5 bg-gray-800/90 backdrop-blur-sm rounded-lg shadow-lg space-x-2">
      {/* Main Controls Group */}
      <div className="flex items-center space-x-2">
        {/* Microphone Button */}
        <div className={buttonBaseClasses} title="Toggle Microphone">
          <SpeakingWhileMutedNotification>
            <div className={iconWrapperClasses}>
              <ToggleAudioPublishingButton />
            </div>
          </SpeakingWhileMutedNotification>
          <span className="mt-1">Mic</span>
        </div>

        {/* Camera Button */}
        <div className={buttonBaseClasses} title="Toggle Camera">
          <div className={iconWrapperClasses}>
            <ToggleVideoPublishingButton />
          </div>
          <span className="mt-1">Camera</span>
        </div>

        {/* Reactions Button */}
        <div className={buttonBaseClasses} title="Send Reaction">
          <div className={iconWrapperClasses}>
            <ReactionsButton />
          </div>
          <span className="mt-1">Reactions</span>
        </div>

        {/* Screen Share Button */}
        <div className={buttonBaseClasses} title="Share Screen">
          <div className={iconWrapperClasses}>
            <ScreenShareButton />
          </div>
          <span className="mt-1">Share</span>
        </div>

        {/* Record Button */}
        <div className={buttonBaseClasses} title="Toggle Recording">
          <div className={iconWrapperClasses}>
            <RecordCallButton />
          </div>
          <span className="mt-1">Record</span>
        </div>

        {/* Leave Button */}
        <div className={endCallButtonBaseClasses} title="Leave Call">
          <div className={endCallIconWrapperClasses}>
            <CancelCallButton onLeave={onLeave} />
          </div>
          <span className="mt-1">Leave</span>
        </div>
      </div>
      {/* Separator */}
      <div className="h-6 w-px bg-gray-600 mx-2 self-center"></div>{" "}
      {/* Align separator centrally */}
      {/* Additional Controls Group */}
      <div className="flex items-center space-x-2">
        {/* Layout Dropdown - Styled Consistently */}
        <div className={buttonBaseClasses} title="Change Layout">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <div className={iconWrapperClasses}>
                <LayoutList size={20} className="text-white" />
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="border bg-popover text-popover-foreground min-w-[150px] rounded-md p-1 mb-2 shadow-lg" // Use theme colors, add border/shadow
            >
              {["Grid", "Speaker-Left", "Speaker-Right"].map((item) => (
                <React.Fragment key={item}>
                  <DropdownMenuItem
                    key={item}
                    // Use Tailwind classes for styling and interactivity
                    className="cursor-pointer rounded-sm px-3 py-1.5 text-sm font-medium hover:bg-accent focus:bg-accent focus:outline-none"
                    onClick={
                      () =>
                        setLayout(
                          item
                            .toLowerCase()
                            .replace("-", "_") as CallLayoutType,
                        ) // Ensure layout key format matches type if necessary
                    }
                  >
                    {item}
                  </DropdownMenuItem>
                  {/* Use theme color for separator */}
                  {item !== "Speaker-Right" && (
                    <DropdownMenuSeparator className="bg-border my-1 h-px" />
                  )}
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="mt-1">Layout</span>
        </div>

        {/* Custom Stats Button */}
        <div className={buttonBaseClasses} title="Call Statistics">
          <button
            onClick={handleStatsClick}
            className="focus:outline-none border-none"
          >
            <div className={iconWrapperClasses}>
              <BarChart size={20} className="text-white" />
            </div>
          </button>
          <span className="mt-1">Stats</span>
        </div>

        {/* Participants Toggle Button */}
        <div className={buttonBaseClasses} title="Toggle Participants">
          <button
            onClick={handleParticipantsClick}
            className="focus:outline-none border-none"
          >
            <div className={iconWrapperClasses}>
              <Users size={20} className="text-white" />
            </div>
          </button>
          <span className="mt-1">Users</span>
        </div>

        {/* Conditionally Render EndCallButton */}
        {!isPersonalRoom && (
          // Use the actual EndCallForEveryoneButton component wrapped for styling
          <div
            className={endCallButtonBaseClasses}
            title="End Call for Everyone"
          >
            <EndCallForEveryoneButton />
          </div>
          // NOTE: Using the actual <EndCallButton/> component here might be better
          // if it contains important logic (like the hold-to-confirm)
          // but it won't match the style unless modified as done previously.
          // <EndCallButton /> // Removed original placeholder comment/structure
        )}
      </div>
      {/* Conditionally Render CallStats Component */}
      {showStats && (
        <div className="absolute bottom-16 right-2 bg-gray-800 p-2 rounded-lg shadow-lg z-50 max-w-xs w-full">
          {/* Render CallStats without the onClose prop */}
          <CallStats />
        </div>
      )}
    </div>
  );
};

export default CustomCallControls;
