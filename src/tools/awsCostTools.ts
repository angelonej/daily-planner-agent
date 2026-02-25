/**
 * awsCostTools.ts
 *
 * Queries AWS Cost Explorer for:
 *  - Month-to-date actual spend (by service)
 *  - Projected end-of-month spend
 *  - Yesterday's spend
 *
 * Requires the EC2 instance role (or env creds) to have:
 *   ce:GetCostAndUsage
 *   ce:GetCostForecast
 */

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
  type GetCostAndUsageCommandInput,
  type GetCostForecastCommandInput,
} from "@aws-sdk/client-cost-explorer";

const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";

function getClient(): CostExplorerClient {
  // Cost Explorer is a global service but must use us-east-1
  return new CostExplorerClient({ region: "us-east-1" });
}

/** Returns YYYY-MM-DD for today */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns YYYY-MM-DD for the first day of the current month */
function startOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/** Returns YYYY-MM-DD for the first day of next month (exclusive end for forecasts) */
function startOfNextMonth(): string {
  const d = new Date();
  const nextMonth = d.getMonth() === 11 ? 0 : d.getMonth() + 1;
  const nextYear  = d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear();
  return `${nextYear}-${String(nextMonth + 1).padStart(2, "0")}-01`;
}

/** Returns YYYY-MM-DD for yesterday */
function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface AwsCostSummary {
  periodStart: string;
  periodEnd: string;
  /** Month-to-date total in USD */
  mtdTotalUSD: number;
  /** Forecast to end of month in USD (null if not available) */
  forecastTotalUSD: number | null;
  /** Yesterday's spend in USD */
  yesterdayUSD: number;
  /** Top services by spend */
  byService: Array<{ service: string; amountUSD: number }>;
  /** Projected daily burn rate (MTD / days elapsed) */
  dailyAvgUSD: number;
}

export async function getAwsCostSummary(): Promise<AwsCostSummary> {
  const client = getClient();
  const start  = startOfMonth();
  const end    = today();
  const todayDate = today();

  // ── MTD cost by service ────────────────────────────────────────────────
  const mtdInput: GetCostAndUsageCommandInput = {
    TimePeriod: { Start: start, End: end },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  };

  const mtdRes = await client.send(new GetCostAndUsageCommand(mtdInput));
  const results = mtdRes.ResultsByTime?.[0];

  let mtdTotalUSD = 0;
  const byService: Array<{ service: string; amountUSD: number }> = [];

  if (results?.Groups) {
    for (const g of results.Groups) {
      const svc = g.Keys?.[0] ?? "Unknown";
      const amt = parseFloat(g.Metrics?.UnblendedCost?.Amount ?? "0");
      if (amt > 0) byService.push({ service: svc, amountUSD: amt });
      mtdTotalUSD += amt;
    }
    byService.sort((a, b) => b.amountUSD - a.amountUSD);
  }

  // ── Yesterday's cost (total only) ─────────────────────────────────────
  let yesterdayUSD = 0;
  try {
    const ydInput: GetCostAndUsageCommandInput = {
      TimePeriod: { Start: yesterday(), End: todayDate },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
    };
    const ydRes = await client.send(new GetCostAndUsageCommand(ydInput));
    yesterdayUSD = parseFloat(
      ydRes.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount ?? "0"
    );
  } catch {
    // Non-fatal — forecast service may require billing data delay
  }

  // ── End-of-month forecast ──────────────────────────────────────────────
  let forecastTotalUSD: number | null = null;
  try {
    const forecastInput: GetCostForecastCommandInput = {
      TimePeriod: { Start: todayDate, End: startOfNextMonth() },
      Metric: "UNBLENDED_COST",
      Granularity: "MONTHLY",
    };
    const forecastRes = await client.send(new GetCostForecastCommand(forecastInput));
    const forecastAmt = parseFloat(
      forecastRes.Total?.Amount ?? "-1"
    );
    if (forecastAmt >= 0) {
      // Forecast is from TODAY to end of month — add MTD to get full-month projection
      forecastTotalUSD = mtdTotalUSD + forecastAmt;
    }
  } catch {
    // Cost Forecast requires at least 3 days of data — may fail for new accounts
  }

  // ── Daily average ──────────────────────────────────────────────────────
  const daysElapsed = Math.max(1, new Date().getDate() - 1); // days completed
  const dailyAvgUSD = mtdTotalUSD / daysElapsed;

  return {
    periodStart:    start,
    periodEnd:      end,
    mtdTotalUSD,
    forecastTotalUSD,
    yesterdayUSD,
    byService:      byService.slice(0, 10), // top 10 services
    dailyAvgUSD,
  };
}

/** Human-readable summary string for the chat agent */
export function formatAwsCostSummary(s: AwsCostSummary): string {
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const lines: string[] = [
    `**AWS Cost — ${s.periodStart} to ${s.periodEnd}**`,
    `• Month-to-date: **${fmt(s.mtdTotalUSD)}**`,
  ];

  if (s.forecastTotalUSD !== null) {
    lines.push(`• Full-month forecast: **${fmt(s.forecastTotalUSD)}**`);
  }

  lines.push(`• Yesterday: ${fmt(s.yesterdayUSD)}`);
  lines.push(`• Daily avg (MTD): ${fmt(s.dailyAvgUSD)}/day`);

  if (s.byService.length > 0) {
    lines.push(`\n**Top services:**`);
    for (const svc of s.byService.slice(0, 6)) {
      lines.push(`• ${svc.service}: ${fmt(svc.amountUSD)}`);
    }
  }

  return lines.join("\n");
}
