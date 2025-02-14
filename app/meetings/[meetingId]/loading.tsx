export default function MeetingRoomLoading() {
  return (
    <div className="flex items-center justify-center h-[calc(100vh-80px)] mt-20">
      <div className="text-center">
        <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <h2 className="text-2xl font-semibold mb-2">Loading meeting room...</h2>
        <p className="text-muted-foreground">Please wait while we set up your meeting.</p>
      </div>
    </div>
  );
}
