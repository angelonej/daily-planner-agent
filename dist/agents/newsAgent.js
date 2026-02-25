import { searchNews, getMorningTopics } from "../tools/newsTools.js";
export async function newsAgent(topics) {
    const resolvedTopics = topics ?? getMorningTopics();
    // Fetch all topics in parallel instead of sequentially
    const results = await Promise.all(resolvedTopics.map(async (topic) => {
        const articles = await searchNews(topic, 3);
        return { topic, articles };
    }));
    return results;
}
