/**
 * SSM Parameter Store token storage
 *
 * When USE_SSM=true, OAuth tokens are stored in AWS SSM instead of
 * the local filesystem. This is used when running on EC2 so tokens
 * survive redeploys without needing to re-run the auth flow.
 *
 * Token paths in SSM:
 *   /daily-planner/tokens/personal
 *   /daily-planner/tokens/work
 *
 * To upload tokens to SSM after running npm run auth locally:
 *   npm run upload-tokens-ssm
 *
 * Required IAM permissions for the EC2 instance role:
 *   ssm:GetParameter
 *   ssm:PutParameter
 */

import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  ParameterType,
} from "@aws-sdk/client-ssm";

const SSM_PREFIX = process.env.SSM_PREFIX ?? "/daily-planner/tokens";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";

// In-process token cache — avoids repeated SSM round-trips on every request.
// Tokens are refreshed from SSM when the cached copy is older than 30 minutes.
const SSM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const tokenCache = new Map<string, { tokens: Record<string, unknown>; fetchedAt: number }>();
// Deduplicate concurrent fetches for the same alias
const tokenInflight = new Map<string, Promise<Record<string, unknown>>>();

let client: SSMClient | null = null;

function getClient(): SSMClient {
  if (!client) {
    client = new SSMClient({ region: AWS_REGION });
  }
  return client;
}

export function useSSM(): boolean {
  return process.env.USE_SSM === "true";
}

/** Invalidate a cached token (call after saving a refreshed token to SSM) */
export function invalidateSsmTokenCache(alias?: string): void {
  if (alias) {
    tokenCache.delete(alias);
  } else {
    tokenCache.clear();
  }
}

export async function getTokenFromSSM(alias: string): Promise<Record<string, unknown>> {
  const now = Date.now();

  // Return from in-process cache if still fresh
  const cached = tokenCache.get(alias);
  if (cached && now - cached.fetchedAt < SSM_CACHE_TTL_MS) {
    return cached.tokens;
  }

  // Deduplicate concurrent fetches for the same alias
  const inflight = tokenInflight.get(alias);
  if (inflight) return inflight;

  const paramName = `${SSM_PREFIX}/${alias}`;
  const fetchPromise = (async (): Promise<Record<string, unknown>> => {
    try {
      const res = await getClient().send(
        new GetParameterCommand({ Name: paramName, WithDecryption: true })
      );
      const value = res.Parameter?.Value;
      if (!value) throw new Error(`SSM parameter ${paramName} is empty`);
      const tokens = JSON.parse(value) as Record<string, unknown>;
      tokenCache.set(alias, { tokens, fetchedAt: Date.now() });
      return tokens;
    } catch (err: unknown) {
      // On error, return stale cache if available rather than failing
      const stale = tokenCache.get(alias);
      if (stale) {
        console.warn(`⚠️  SSM fetch failed for "${alias}", using stale cache:`, err instanceof Error ? err.message : String(err));
        return stale.tokens;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to load token for "${alias}" from SSM (${paramName}): ${msg}\n` +
          `Run 'npm run upload-tokens-ssm' to upload your local tokens to SSM.`
      );
    } finally {
      tokenInflight.delete(alias);
    }
  })();

  tokenInflight.set(alias, fetchPromise);
  return fetchPromise;
}

export async function saveTokenToSSM(
  alias: string,
  tokens: Record<string, unknown>
): Promise<void> {
  const paramName = `${SSM_PREFIX}/${alias}`;
  await getClient().send(
    new PutParameterCommand({
      Name: paramName,
      Value: JSON.stringify(tokens),
      Type: ParameterType.SECURE_STRING,
      Overwrite: true,
      Description: `OAuth2 tokens for Daily Planner Agent account: ${alias}`,
    })
  );
  // Update in-process cache immediately so next request uses the fresh token
  tokenCache.set(alias, { tokens, fetchedAt: Date.now() });
  console.log(`✅ Token saved to SSM: ${paramName}`);
}
