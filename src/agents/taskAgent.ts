import { getTasks } from "../tools/taskTools.js";

export async function taskAgent() {
  return getTasks().sort((a, b) => a.priority - b.priority);
}
