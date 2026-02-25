import fetch from "node-fetch";
import { NewsArticle } from "../types.js";

interface GNewsArticle {
  title: string;
  url: string;
  source: { name: string };
  publishedAt: string;
  description: string;
}

interface GNewsResponse {
  articles?: GNewsArticle[];
  errors?: string[];
}

export async function searchNews(topic: string, maxResults = 3): Promise<NewsArticle[]> {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) {
    console.warn("NEWS_API_KEY not set — skipping news fetch.");
    return [];
  }

  try {
    const url =
      `https://gnews.io/api/v4/search` +
      `?q=${encodeURIComponent(topic)}` +
      `&token=${apiKey}` +
      `&max=${maxResults}` +
      `&lang=en` +
      `&sortby=publishedAt`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error(`GNews API error ${res.status} for topic "${topic}"`);
      return [];
    }

    const data = (await res.json()) as GNewsResponse;

    if (!data.articles || data.articles.length === 0) return [];

    return data.articles.map((a) => ({
      title: a.title,
      url: a.url,
      source: a.source?.name ?? "Unknown",
      publishedAt: a.publishedAt,
      description: a.description ?? "",
    }));
  } catch (err) {
    console.error(`Failed to fetch news for "${topic}":`, err);
    return [];
  }
}

// Default morning topics — override via NEWS_TOPICS env var (comma-separated)
export function getMorningTopics(): string[] {
  const envTopics = process.env.NEWS_TOPICS;
  if (envTopics) {
    return envTopics.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return ["Artificial Intelligence", "AWS Cloud", "Florida real estate market"];
}

