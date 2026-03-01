/**
 * DynamoDB persistence for settings and agent memory.
 *
 * Table layout (single table, PAY_PER_REQUEST):
 *   PK  = "user#<userId>"   (String)
 *   SK  = "settings" | "memory"   (String)
 *
 * Settings item  → { PK, SK:"settings", ...PersistedSettings }
 * Memory item    → { PK, SK:"memory",  facts: string[], updatedAt: string }
 *
 * Required env var: DYNAMO_TABLE (e.g. "planner-data")
 * AWS credentials come from the EC2 instance role — no keys needed.
 *
 * If DYNAMO_TABLE is not set, every function is a no-op and callers
 * fall back to the local settings.json file.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.DYNAMO_TABLE ?? "";

let _client: DynamoDBDocumentClient | null = null;

function getClient(): DynamoDBDocumentClient | null {
  if (!TABLE) return null;
  if (!_client) {
    const raw = new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" });
    _client = DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _client;
}

const USER_ID = "default"; // single-user app — expand later if needed

function pk(userId = USER_ID) {
  return `user#${userId}`;
}

// ─── Settings ──────────────────────────────────────────────────────────────

export interface StoredSettings {
  newsTopics?: string[];
  morningBriefingTime?: string;
  eveningBriefingTime?: string;
  vipSenders?: string[];
  filterKeywords?: string[];
  awsCostThreshold?: number;
  assistantName?: string;
  tone?: string;
}

export async function getSettingsFromDynamo(userId = USER_ID): Promise<StoredSettings | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const result = await client.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: pk(userId), SK: "settings" },
    }));
    if (!result.Item) return null;
    const { PK, SK, ...rest } = result.Item as any;
    return rest as StoredSettings;
  } catch (err) {
    console.error("[DynamoDB] getSettings error:", err);
    return null;
  }
}

export async function saveSettingsToDynamo(settings: StoredSettings, userId = USER_ID): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: pk(userId),
        SK: "settings",
        ...settings,
        updatedAt: new Date().toISOString(),
      },
    }));
  } catch (err) {
    console.error("[DynamoDB] saveSettings error:", err);
  }
}

// ─── Memory ────────────────────────────────────────────────────────────────
// "Memory" is a list of plain-text facts the agent should always remember.
// e.g. "User's daughter is named Emma", "User prefers morning workouts", etc.
// Max 100 facts — oldest trimmed automatically.

const MAX_FACTS = 100;

export async function getMemoryFacts(userId = USER_ID): Promise<string[]> {
  const client = getClient();
  if (!client) return [];
  try {
    const result = await client.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: pk(userId), SK: "memory" },
    }));
    return (result.Item?.facts as string[]) ?? [];
  } catch (err) {
    console.error("[DynamoDB] getMemory error:", err);
    return [];
  }
}

export async function saveMemoryFacts(facts: string[], userId = USER_ID): Promise<void> {
  const client = getClient();
  if (!client) return;
  const trimmed = facts.slice(-MAX_FACTS);
  try {
    await client.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: pk(userId),
        SK: "memory",
        facts: trimmed,
        updatedAt: new Date().toISOString(),
      },
    }));
  } catch (err) {
    console.error("[DynamoDB] saveMemory error:", err);
  }
}

/** Add one or more facts, deduplicating and trimming to MAX_FACTS. */
export async function appendMemoryFacts(newFacts: string[], userId = USER_ID): Promise<string[]> {
  const existing = await getMemoryFacts(userId);
  // Deduplicate (case-insensitive check)
  const lowerExisting = existing.map(f => f.toLowerCase());
  const toAdd = newFacts.filter(f => !lowerExisting.includes(f.toLowerCase().trim()));
  const merged = [...existing, ...toAdd].slice(-MAX_FACTS);
  await saveMemoryFacts(merged, userId);
  return merged;
}

/** Remove facts by index (0-based). Used when user says "forget that". */
export async function removeMemoryFacts(indices: number[], userId = USER_ID): Promise<string[]> {
  const existing = await getMemoryFacts(userId);
  const remaining = existing.filter((_, i) => !indices.includes(i));
  await saveMemoryFacts(remaining, userId);
  return remaining;
}

/** Clear all memory facts. */
export async function clearMemoryFacts(userId = USER_ID): Promise<void> {
  await saveMemoryFacts([], userId);
}

/** Returns true if DYNAMO_TABLE env var is configured. */
export function isDynamoConfigured(): boolean {
  return Boolean(TABLE);
}
