/**
 * packageTools.ts
 * Scans fetched emails for shipping tracking numbers and returns PackageInfo objects.
 * No external tracking API calls — just extracts tracking numbers + carrier URLs.
 */
// ─── Carrier patterns ───────────────────────────────────────────────────────
const PATTERNS = [
    {
        // Amazon Logistics TBA tracking numbers
        carrier: "Amazon",
        regex: /\bTBA\d{9,16}\b/gi,
        url: (n) => `https://track.amazon.com/tracking/${n}`,
    },
    {
        // Amazon order numbers (e.g. 112-3456789-1234567)
        carrier: "Amazon",
        regex: /\b(\d{3}-\d{7}-\d{7})\b/g,
        url: (n) => `https://www.amazon.com/gp/your-account/order-details?orderID=${n}`,
    },
    {
        carrier: "UPS",
        regex: /\b(1Z[A-Z0-9]{16})\b/gi,
        url: (n) => `https://www.ups.com/track?tracknum=${n}`,
    },
    {
        carrier: "FedEx",
        regex: /\b(\d{12}|\d{15}|\d{20}|\d{22})\b/g,
        url: (n) => `https://www.fedex.com/fedextrack/?tracknumbers=${n}`,
    },
    {
        carrier: "USPS",
        regex: /\b(9[2-4]\d{18,20})\b/g,
        url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
    },
];
// Keywords in subject/snippet that suggest shipping notifications
const SHIPPING_KEYWORDS = [
    "tracking", "shipped", "shipment", "package", "delivery", "delivered",
    "out for delivery", "on its way", "order shipped", "order update",
    "ups", "fedex", "usps", "amazon", "dhl", "arriving",
    "order", "dispatched", "is on the way", "has been shipped", "expected delivery",
    "estimated delivery", "will arrive", "preparing for shipment", "order confirmation",
];
// Keywords that strongly suggest the package arrives or arrived TODAY
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
    "arriving by end of day",
    "arriving soon",
];
// Keywords that mean "delivered" — shown when the email is recent (today or yesterday)
const DELIVERED_KEYWORDS = [
    "delivered",
    "your order has been delivered",
    "your package has been delivered",
    "package was delivered",
    "order delivered",
];
/** Returns true if the email text strongly suggests delivery today or a recent delivery notification */
function isArrivingToday(subject, snippet, emailDate) {
    const combined = `${subject} ${snippet}`.toLowerCase();
    if (TODAY_KEYWORDS.some((kw) => combined.includes(kw)))
        return true;
    // Check if the email was received today or yesterday
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const todayStr = now.toISOString().slice(0, 10);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    const isRecent = emailDate.startsWith(todayStr) ||
        emailDate.startsWith(yesterdayStr) ||
        emailDate.includes(now.toLocaleDateString("en-US", { month: "short", day: "numeric" })) ||
        emailDate.includes(yesterday.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    // Recent delivery confirmation = show it
    if (isRecent && DELIVERED_KEYWORDS.some((kw) => combined.includes(kw)))
        return true;
    // Recent in-transit email
    if (isRecent && (combined.includes("out for delivery") || combined.includes("on its way")))
        return true;
    return false;
}
/** Detect likely carrier from email sender/subject when no tracking number is present */
function detectCarrierFromEmail(from, subject) {
    const text = `${from} ${subject}`.toLowerCase();
    if (text.includes("amazon"))
        return "Amazon";
    if (text.includes("ups"))
        return "UPS";
    if (text.includes("fedex"))
        return "FedEx";
    if (text.includes("usps") || text.includes("postal"))
        return "USPS";
    return "Unknown";
}
function looksLikeShippingEmail(subject, snippet) {
    const combined = `${subject} ${snippet}`.toLowerCase();
    return SHIPPING_KEYWORDS.some((kw) => combined.includes(kw));
}
function extractTrackingNumbers(text) {
    const results = [];
    const seen = new Set();
    for (const { carrier, regex, url } of PATTERNS) {
        regex.lastIndex = 0; // reset stateful regex
        let match;
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
 * daysBack controls how far back to search (default 7, max 30).
 */
export async function getTrackedPackages(prefetchedEmails, daysBack = 7) {
    const { fetchShippingEmails } = await import("./gmailTools.js");
    const emails = prefetchedEmails ?? await fetchShippingEmails(Math.min(daysBack, 30));
    const packages = [];
    const seenTrackingNums = new Set();
    for (const email of emails) {
        if (!looksLikeShippingEmail(email.subject, email.snippet))
            continue;
        const combined = `${email.subject} ${email.snippet}`;
        const found = extractTrackingNumbers(combined);
        const arriving = isArrivingToday(email.subject, email.snippet, email.date);
        if (found.length > 0) {
            for (const { carrier, number, url } of found) {
                if (seenTrackingNums.has(number))
                    continue;
                seenTrackingNums.add(number);
                packages.push({
                    trackingNumber: number,
                    carrier,
                    trackingUrl: url,
                    emailSubject: email.subject,
                    emailFrom: email.from,
                    emailDate: email.date,
                    arrivingToday: arriving,
                });
            }
        }
        else if (arriving) {
            // No tracking number found but email clearly says arriving today —
            // create an entry anyway (common with Amazon "out for delivery" emails
            // that only include an order number in a link, not plain text)
            const carrier = detectCarrierFromEmail(email.from, email.subject);
            const syntheticKey = `no-tracking-${email.id}`;
            if (!seenTrackingNums.has(syntheticKey)) {
                seenTrackingNums.add(syntheticKey);
                packages.push({
                    trackingNumber: "View order →",
                    carrier,
                    trackingUrl: carrier === "Amazon"
                        ? "https://www.amazon.com/gp/your-account/order-history"
                        : "#",
                    emailSubject: email.subject,
                    emailFrom: email.from,
                    emailDate: email.date,
                    arrivingToday: true,
                });
            }
        }
    }
    return packages;
}
