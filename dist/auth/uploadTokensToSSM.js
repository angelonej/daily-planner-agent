/**
 * Upload local OAuth tokens to AWS SSM Parameter Store
 *
 * Run this once after completing `npm run auth -- personal` and
 * `npm run auth -- work` on your local machine, before deploying to EC2.
 *
 * Usage:
 *   npm run upload-tokens-ssm
 *
 * Requires AWS credentials in your local environment:
 *   aws configure   (or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
 */
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { saveTokenToSSM } from "../tools/ssmTools.js";
dotenv.config();
const TOKEN_DIR = path.resolve("tokens");
async function main() {
    if (!fs.existsSync(TOKEN_DIR)) {
        console.error(`No tokens/ directory found. Run 'npm run auth -- personal' first.`);
        process.exit(1);
    }
    const files = fs.readdirSync(TOKEN_DIR).filter((f) => f.endsWith(".token.json"));
    if (files.length === 0) {
        console.error("No token files found in tokens/. Run auth first.");
        process.exit(1);
    }
    console.log(`\nUploading ${files.length} token(s) to AWS SSM...\n`);
    for (const file of files) {
        const alias = file.replace(".token.json", "");
        const tokenPath = path.join(TOKEN_DIR, file);
        const tokens = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
        try {
            await saveTokenToSSM(alias, tokens);
            console.log(`  ✅ ${alias}`);
        }
        catch (err) {
            console.error(`  ❌ ${alias}:`, err);
        }
    }
    console.log("\nDone! On EC2, set USE_SSM=true in your .env to use these tokens.\n");
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
