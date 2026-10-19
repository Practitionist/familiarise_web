"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatRupees, formatRupeesCompact } from "@/lib/backoffice/rupees";
import type { MoneyTrendPoint } from "@/lib/backoffice/money-overview";

/**
 * GMV and net revenue over the window, with the gap between them shaded and
 * the previous period as the comparison baseline.
 *
 * Two lines, never a second y-axis: the take rate is its own panel, because
 * a percentage and a rupee amount on one pair of axes is a chart nobody can
 * read. The band is drawn with two stacked areas — an invisible base at net
 * revenue and a visible one for the difference up to GMV — which is the only
 * way recharts can fill between two lines.
 */
export default function MoneyOverviewTrendChart({
  series,
}: Readonly<{ series: MoneyTrendPoint[] }>) {
  const data = series.map((point) => ({
    label: point.label,
    gmv: point.gmvPaise,
    net: point.netRevenuePaise,
    band: point.gmvPaise - point.netRevenuePaise,
    priorGmv: point.priorGmvPaise,
  }));

  return (
    <div style={{ width: "100%", height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis
            dataKey="label"
            stroke="#64748b"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            stroke="#64748b"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            width={64}
            tickFormatter={(value: number) => formatRupeesCompact(value)}
          />
          <Tooltip
            formatter={(value: number, name: string) => [
              formatRupees(value),
              name,
            ]}
            contentStyle={{ fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area
            dataKey="net"
            stackId="band"
            fill="transparent"
            stroke="none"
            isAnimationActive={false}
            legendType="none"
          />
          <Area
            dataKey="band"
            stackId="band"
            name="Net revenue → GMV"
            fill="hsl(var(--chart-2))"
            fillOpacity={0.16}
            stroke="none"
            isAnimationActive={false}
          />
          <Line
            dataKey="gmv"
            name="GMV"
            stroke="hsl(var(--chart-1))"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="net"
            name="Net revenue"
            stroke="hsl(var(--chart-2))"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="priorGmv"
            name="GMV · previous period"
            stroke="hsl(var(--chart-1))"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            opacity={0.55}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
