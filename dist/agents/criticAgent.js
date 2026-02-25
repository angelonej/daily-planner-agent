import { hasConflict } from "../tools/scheduleTools.js";
// Synchronous — no I/O needed
export function criticAgent(schedule) {
    const conflict = hasConflict(schedule);
    return {
        valid: !conflict,
        reason: conflict ? "Schedule has time conflicts" : "Schedule valid"
    };
}
