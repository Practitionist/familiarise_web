import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SlotTypeLegend() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Slot Types</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded text-xs font-medium bg-blue-100 text-blue-800">
            📅 Weekly
          </span>
          <span className="text-sm text-gray-600">Regular schedule</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-800">
            🎯 Custom
          </span>
          <span className="text-sm text-gray-600">Special occasion</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default SlotTypeLegend;
