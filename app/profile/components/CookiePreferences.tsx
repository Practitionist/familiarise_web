import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CookieIcon } from "./Icons";

export function CookiePreferences() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center">
          <CookieIcon className="w-5 h-5 text-gray-400 mr-2" />
          <CardTitle>Cookie Preferences</CardTitle>
        </div>
        <CardDescription>
          Manage your cookie settings. You can enable or disable different types
          of cookies below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="essential">Essential Cookies</Label>
            <p className="text-sm text-gray-500">
              These cookies are necessary for the website to function and cannot
              be switched off.
            </p>
          </div>
          <Switch id="essential" />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="analytics">Analytics Cookies</Label>
            <p className="text-sm text-gray-500">
              These cookies allow us to count visits and traffic sources, so we
              can measure and improve the performance of our site.
            </p>
          </div>
          <Switch id="analytics" />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="marketing">Marketing Cookies</Label>
            <p className="text-sm text-gray-500">
              These cookies help us show you relevant ads.
            </p>
          </div>
          <Switch id="marketing" />
        </div>
      </CardContent>
    </Card>
  );
}
