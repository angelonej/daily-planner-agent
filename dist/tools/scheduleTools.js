export function hasConflict(schedule) {
    for (let i = 0; i < schedule.length - 1; i++) {
        if (schedule[i].end > schedule[i + 1].start) {
            return true;
        }
    }
    return false;
}
