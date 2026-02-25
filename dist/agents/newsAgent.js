import { searchNews, getMorningTopics } from "../tools/newsTools.js";
export async function newsAgent(topics) {
    const resolvedTopics = topics ?? getMorningTopics();
    const results = [];
    for (const topic of resolvedTopics) {
        const articles = await searchNews(topic, 3);
        results.push({ topic, articles });
    }
    return results;
}
