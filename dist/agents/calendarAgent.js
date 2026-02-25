import { getCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, findEventsByTitle, } from "../tools/calendarTools.js";
export async function calendarAgent(daysAhead = 1) {
    return getCalendarEvents(daysAhead);
}
export async function createEvent(params) {
    return createCalendarEvent(params);
}
export async function updateEvent(params) {
    return updateCalendarEvent(params);
}
export async function deleteEvent(eventId) {
    return deleteCalendarEvent(eventId);
}
export async function searchEvents(query, daysToSearch = 14) {
    return findEventsByTitle(query, daysToSearch);
}
