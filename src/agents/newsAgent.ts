import { searchNews, getMorningTopics } from "../tools/newsTools.js";
import { NewsResult } from "../types.js";

export async function newsAgent(topics?: string[]): Promise<NewsResult[]> {
  const resolvedTopics = topics ?? getMorningTopics();
  const results: NewsResult[] = [];

  for (const topic of resolvedTopics) {
    const articles = await searchNews(topic, 3);
    results.push({ topic, articles });
  }

  return results;
}
