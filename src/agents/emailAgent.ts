import { fetchAllAccountEmails } from "../tools/gmailTools.js";
import { Email } from "../types.js";

export async function emailAgent(): Promise<Email[]> {
  return fetchAllAccountEmails();
}

export function filterImportant(emails: Email[]): Email[] {
  return emails.filter((e) => e.isImportant);
}
