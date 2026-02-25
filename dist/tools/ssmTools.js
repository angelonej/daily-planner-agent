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
import { SSMClient, GetParameterCommand, PutParameterCommand, ParameterType, } from "@aws-sdk/client-ssm";
const SSM_PREFIX = process.env.SSM_PREFIX ?? "/daily-planner/tokens";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
let client = null;
function getClient() {
    if (!client) {
        client = new SSMClient({ region: AWS_REGION });
    }
    return client;
}
export function useSSM() {
    return process.env.USE_SSM === "true";
}
export async function getTokenFromSSM(alias) {
    const paramName = `${SSM_PREFIX}/${alias}`;
    try {
        const res = await getClient().send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
        const value = res.Parameter?.Value;
        if (!value)
            throw new Error(`SSM parameter ${paramName} is empty`);
        return JSON.parse(value);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to load token for "${alias}" from SSM (${paramName}): ${msg}\n` +
            `Run 'npm run upload-tokens-ssm' to upload your local tokens to SSM.`);
    }
}
export async function saveTokenToSSM(alias, tokens) {
    const paramName = `${SSM_PREFIX}/${alias}`;
    await getClient().send(new PutParameterCommand({
        Name: paramName,
        Value: JSON.stringify(tokens),
        Type: ParameterType.SECURE_STRING,
        Overwrite: true,
        Description: `OAuth2 tokens for Daily Planner Agent account: ${alias}`,
    }));
    console.log(`✅ Token saved to SSM: ${paramName}`);
}
