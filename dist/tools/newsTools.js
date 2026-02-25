import fetch from "node-fetch";
/**
 * Fetch news from Google News RSS (no API key, no rate limits).
 * Falls back to empty array on error.
 */
export async function searchNews(topic, maxResults = 3) {
    try {
        const url = `https://news.google.com/rss/search` +
            `?q=${encodeURIComponent(topic)}` +
            `&hl=en-US&gl=US&ceid=US:en`;
        const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; DailyPlannerBot/1.0)" },
            redirect: "follow",
        });
        if (!res.ok) {
            console.error(`Google News RSS error ${res.status} for topic "${topic}"`);
            return [];
        }
        const xml = await res.text();
        return parseRssItems(xml, maxResults);
    }
    catch (err) {
        console.error(`Failed to fetch news for "${topic}":`, err);
        return [];
    }
}
function parseRssItems(xml, max) {
    const items = [];
    // Match each <item>...</item> block
    const itemRe = /<item>([\.\s\S]*?)<\/item>/g;
    let itemMatch;
    while ((itemMatch = itemRe.exec(xml)) !== null && items.length < max) {
        const block = itemMatch[1];
        const title = stripHtml(extract(block, "title"));
        const link = extract(block, "link") || extractCdata(block, "link");
        const pubDate = extract(block, "pubDate");
        const source = extractAttr(block, "source") || "Google News";
        // Description in Google News RSS contains an HTML snippet — strip to get plain text
        const desc = stripHtml(extract(block, "description")).slice(0, 200);
        if (!title || !link)
            continue;
        // Convert Google News redirect URL — keep as-is (links open fine)
        items.push({
            title,
            url: link,
            source,
            publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
            description: desc,
        });
    }
    return items;
}
function extract(xml, tag) {
    // Handles both plain text and CDATA
    const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))`, "i");
    const m = re.exec(xml);
    if (!m)
        return "";
    return (m[1] ?? m[2] ?? "").trim();
}
function extractCdata(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, "i");
    const m = re.exec(xml);
    return m ? m[1].trim() : "";
}
function extractAttr(xml, tag) {
    // <source url="...">Name</source>
    const re = new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`, "i");
    const m = re.exec(xml);
    return m ? m[1].trim() : "";
}
function stripHtml(html) {
    return html
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
}
// Default morning topics — override via NEWS_TOPICS env var (comma-separated)
export function getMorningTopics() {
    const envTopics = process.env.NEWS_TOPICS;
    if (envTopics) {
        return envTopics.split(",").map((t) => t.trim()).filter(Boolean);
    }
    return ["Artificial Intelligence", "AWS Cloud", "Florida real estate market"];
}
