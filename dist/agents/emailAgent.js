import { fetchAllAccountEmails } from "../tools/gmailTools.js";
export async function emailAgent() {
    return fetchAllAccountEmails();
}
export function filterImportant(emails) {
    return emails.filter((e) => e.isImportant);
}
