import { fetchAllAccountEmails } from "../tools/gmailTools.js";
import { getVipSenders, getFilterKeywords } from "../tools/notificationTools.js";
export async function emailAgent() {
    const emails = await fetchAllAccountEmails();
    return tagEmails(emails);
}
/** Tags emails that match VIP senders or filter keywords. */
export function tagEmails(emails) {
    const vipSenders = getVipSenders();
    const filterKeywords = getFilterKeywords();
    return emails.map((email) => {
        const fromLower = email.from.toLowerCase();
        const subjectLower = email.subject.toLowerCase();
        const snippetLower = email.snippet.toLowerCase();
        const isVip = vipSenders.length > 0 && vipSenders.some((v) => fromLower.includes(v));
        const isHighlighted = isVip ||
            (filterKeywords.length > 0 &&
                filterKeywords.some((kw) => subjectLower.includes(kw) || snippetLower.includes(kw) || fromLower.includes(kw)));
        if (isVip || isHighlighted) {
            return { ...email, isVip, isHighlighted };
        }
        return email;
    });
}
export function filterImportant(emails) {
    return emails.filter((e) => e.isImportant);
}
