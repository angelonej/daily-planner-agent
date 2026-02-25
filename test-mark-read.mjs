import { markEmailsAsRead } from "./dist/tools/gmailTools.js";
import dotenv from "dotenv";
dotenv.config();

try {
  const r = await markEmailsAsRead("personal", "is:unread newer_than:1d");
  console.log("SUCCESS:", JSON.stringify(r));
} catch(e) {
  console.log("ERROR:", e.message);
  console.log("CODE:", e.code);
  console.log("STATUS:", e.status);
  if (e.errors) console.log("DETAILS:", JSON.stringify(e.errors));
  if (e.response?.data) console.log("RESPONSE:", JSON.stringify(e.response.data));
}
