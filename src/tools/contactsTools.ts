/**
 * contactsTools.ts
 *
 * Searches Google Contacts (People API v1) by name.
 * Returns name, phone numbers, and email addresses.
 *
 * Scope needed: https://www.googleapis.com/auth/contacts.readonly
 * Re-run `npm run auth -- personal` after adding scope.
 */

import { google } from "googleapis";
import { buildOAuth2Client } from "./gmailTools.js";
import { useSSM, getTokenFromSSM, saveTokenToSSM } from "./ssmTools.js";
import fs from "fs";
import path from "path";

const TOKEN_DIR = path.resolve("tokens");

export interface Contact {
  name: string;
  phones: Array<{ number: string; type: string }>;
  emails: Array<{ address: string; type: string }>;
  company?: string;
  jobTitle?: string;
}

async function buildPeopleClient() {
  const alias = process.env.GMAIL_ACCOUNT_1_ALIAS ?? "personal";
  const auth = buildOAuth2Client();

  let tokens: Record<string, unknown>;
  if (useSSM()) {
    tokens = await getTokenFromSSM(alias);
  } else {
    const tokenPath = path.join(TOKEN_DIR, `${alias}.token.json`);
    if (!fs.existsSync(tokenPath)) throw new Error(`No token for ${alias}. Run: npm run auth -- ${alias}`);
    tokens = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
  }

  auth.setCredentials(tokens);
  auth.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    if (useSSM()) {
      await saveTokenToSSM(alias, merged).catch(console.error);
    } else {
      const tokenPath = path.join(TOKEN_DIR, `${alias}.token.json`);
      fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
    }
  });

  return google.people({ version: "v1", auth });
}

/**
 * Search contacts by name query. Returns up to `maxResults` matches.
 */
export async function searchContacts(query: string, maxResults = 5): Promise<Contact[]> {
  const people = await buildPeopleClient();

  const res = await people.people.searchContacts({
    query,
    readMask: "names,phoneNumbers,emailAddresses,organizations",
    pageSize: maxResults,
  });

  const connections = res.data.results ?? [];
  const contacts: Contact[] = [];

  for (const r of connections) {
    const p = r.person;
    if (!p) continue;

    const name = p.names?.[0]?.displayName ?? "(no name)";
    const phones = (p.phoneNumbers ?? []).map(ph => ({
      number: ph.value ?? "",
      type: ph.formattedType ?? ph.type ?? "phone",
    })).filter(ph => ph.number);
    const emails = (p.emailAddresses ?? []).map(em => ({
      address: em.value ?? "",
      type: em.formattedType ?? em.type ?? "email",
    })).filter(em => em.address);
    const org = p.organizations?.[0];

    contacts.push({
      name,
      phones,
      emails,
      company: org?.name ?? undefined,
      jobTitle: org?.title ?? undefined,
    });
  }

  return contacts;
}

/**
 * Format contact results as a markdown-friendly string with tel: links.
 */
export function formatContacts(contacts: Contact[]): string {
  if (contacts.length === 0) return "No contacts found matching that name.";

  return contacts.map(c => {
    const lines: string[] = [`**${c.name}**`];
    if (c.jobTitle || c.company) {
      lines.push(`${[c.jobTitle, c.company].filter(Boolean).join(" @ ")}`);
    }
    for (const ph of c.phones) {
      lines.push(`📞 [${ph.number}](tel:${ph.number.replace(/\s/g, "")}) *(${ph.type})*`);
    }
    for (const em of c.emails) {
      lines.push(`✉️ [${em.address}](mailto:${em.address}) *(${em.type})*`);
    }
    return lines.join("\n");
  }).join("\n\n");
}
