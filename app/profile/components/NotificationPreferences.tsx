import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

export function NotificationPreferences() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification Preferences</CardTitle>
        <CardDescription>
          Select which notifications you'd like to receive
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium leading-none" htmlFor="all">
              All Notifications
            </Label>
            <p className="text-sm text-gray-500">Receive all notifications.</p>
          </div>
          <Switch id="all" />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label
              className="text-sm font-medium leading-none"
              htmlFor="mentions"
            >
              Mentions
            </Label>
            <p className="text-sm text-gray-500">
              Receive notifications only when someone mentions you.
            </p>
          </div>
          <Switch id="mentions" />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label
              className="text-sm font-medium leading-none"
              htmlFor="direct-messages"
            >
              Direct Messages
            </Label>
            <p className="text-sm text-gray-500">
              Receive notifications for direct messages.
            </p>
          </div>
          <Switch id="direct-messages" />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label
              className="text-sm font-medium leading-none"
              htmlFor="updates"
            >
              Updates
            </Label>
            <p className="text-sm text-gray-500">
              Get notifications about new features and updates.
            </p>
          </div>
          <Switch id="updates" />
        </div>
      </CardContent>
      <CardFooter>
        <Button
          className="ml-auto"
          type="submit"
          style={{ backgroundColor: "black", color: "white" }}
        >
          Save Preferences
        </Button>
      </CardFooter>
    </Card>
  );
}
