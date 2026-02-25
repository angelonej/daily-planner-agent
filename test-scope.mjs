import { getTokenFromSSM } from "./dist/tools/ssmTools.js";
import dotenv from "dotenv";
dotenv.config();

const token = await getTokenFromSSM("personal");
console.log("scope:", token.scope ?? "none");
console.log("token_type:", token.token_type);
console.log("has_access_token:", !!token.access_token);
console.log("has_refresh_token:", !!token.refresh_token);
