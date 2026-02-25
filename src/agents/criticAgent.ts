import { hasConflict } from "../tools/scheduleTools.js";
import { ScheduleBlock } from "../types.js";

// Synchronous — no I/O needed
export function criticAgent(schedule: ScheduleBlock[]) {
  const conflict = hasConflict(schedule);
  return {
    valid: !conflict,
    reason: conflict ? "Schedule has time conflicts" : "Schedule valid"
  };
}
