/**
 * packageTools.ts
 * Scans fetched emails for shipping tracking numbers and returns PackageInfo objects.
 * No external tracking API calls — just extracts tracking numbers + carrier URLs.
 */

import type { PackageInfo, Email } from "../types.js";

// ─── Carrier patterns ───────────────────────────────────────────────────────
const PATTERNS: Array<{
  carrier: PackageInfo["carrier"];
  regex: RegExp;
  url: (n: string) => string;
}> = [
  {
    carrier: "Amazon",
    regex: /\bTBA\d{12,16}\b/gi,
    url: (n) => `https://track.amazon.com/tracking/${n}`,
  },
  {
    carrier: "UPS",
    // 1Z followed by 16 alphanumeric chars
    regex: /\b(1Z[A-Z0-9]{16})\b/gi,
    url: (n) => `https://www.ups.com/track?tracknum=${n}`,
  },
  {
    carrier: "FedEx",
    // 12, 15, 20, or 22 digit numbers typical of FedEx
    regex: /\b(\d{12}|\d{15}|\d{20}|\d{22})\b/g,
    url: (n) => `https://www.fedex.com/fedextrack/?tracknumbers=${n}`,
  },
  {
    carrier: "USPS",
    // 9400, 9205, 9261, 9274, 9300, 9400 prefix 20–22 digit numbers
    regex: /\b(9[2-4]\d{18,20})\b/g,
    url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  },
];

// Keywords in subject/snippet that suggest shipping notifications
const SHIPPING_KEYWORDS = [
  "tracking", "shipped", "shipment", "package", "delivery", "delivered",
  "out for delivery", "on its way", "order shipped", "order update",
  "ups", "fedex", "usps", "amazon", "dhl", "arriving",
];

// Keywords that strongly suggest the package arrives TODAY
const TODAY_KEYWORDS = [
  "out for delivery",
  "arriving today",
  "delivery today",
  "arriving now",
  "will be delivered today",
  "expected today",
  "delivered today",
  "your delivery is today",
  "scheduled for today",
];

/** Returns true if the email text strongly suggests delivery today */
function isArrivingToday(subject: string, snippet: string, emailDate: string): boolean {
  const combined = `${subject} ${snippet}`.toLowerCase();
  if (TODAY_KEYWORDS.some((kw) => combined.includes(kw))) return true;
  // Also flag emails received today that say "out for delivery" or "on its way"
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const isToday = emailDate.startsWith(today) || emailDate.includes(new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  if (isToday && (combined.includes("out for delivery") || combined.includes("on its way"))) return true;
  return false;
}

function looksLikeShippingEmail(subject: string, snippet: string): boolean {
  const combined = `${subject} ${snippet}`.toLowerCase();
  return SHIPPING_KEYWORDS.some((kw) => combined.includes(kw));
}

function extractTrackingNumbers(text: string): Array<{ carrier: PackageInfo["carrier"]; number: string; url: string }> {
  const results: Array<{ carrier: PackageInfo["carrier"]; number: string; url: string }> = [];
  const seen = new Set<string>();

  for (const { carrier, regex, url } of PATTERNS) {
    regex.lastIndex = 0; // reset stateful regex
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const num = match[1] ?? match[0];
      if (!seen.has(num)) {
        seen.add(num);
        results.push({ carrier, number: num, url: url(num) });
      }
    }
  }

  return results;
}

/**
 * Scans emails for tracking numbers.
 * Pass pre-fetched emails to avoid a redundant Gmail API call.
 * If omitted, fetches fresh.
 */
export async function getTrackedPackages(prefetchedEmails?: Email[]): Promise<PackageInfo[]> {
  const { fetchAllAccountEmails } = await import("./gmailTools.js");
  const emails = prefetchedEmails ?? await fetchAllAccountEmails();
  const packages: PackageInfo[] = [];
  const seenTrackingNums = new Set<string>();

  for (const email of emails) {
    if (!looksLikeShippingEmail(email.subject, email.snippet)) continue;

    const combined = `${email.subject} ${email.snippet}`;
    const found = extractTrackingNumbers(combined);

    for (const { carrier, number, url } of found) {
      if (seenTrackingNums.has(number)) continue;
      seenTrackingNums.add(number);

      packages.push({
        trackingNumber: number,
        carrier,
        trackingUrl: url,
        emailSubject: email.subject,
        emailFrom: email.from,
        emailDate: email.date,
        arrivingToday: isArrivingToday(email.subject, email.snippet, email.date),
      });
    }
  }

  return packages;
}
