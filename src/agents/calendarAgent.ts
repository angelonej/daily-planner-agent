import {
  getCalendarEvents,
  getCalendarEventsByRange,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  findEventsByTitle,
  type CreateEventParams,
  type UpdateEventParams,
} from "../tools/calendarTools.js";
import { CalendarEvent } from "../types.js";

export async function calendarAgent(daysAhead = 1): Promise<CalendarEvent[]> {
  return getCalendarEvents(daysAhead);
}

export async function listEventsByRange(startIso: string, endIso: string): Promise<CalendarEvent[]> {
  return getCalendarEventsByRange(startIso, endIso);
}

export async function createEvent(params: CreateEventParams) {
  return createCalendarEvent(params);
}

export async function updateEvent(params: UpdateEventParams) {
  return updateCalendarEvent(params);
}

export async function deleteEvent(eventId: string) {
  return deleteCalendarEvent(eventId);
}

export async function searchEvents(query: string, daysToSearch = 14) {
  return findEventsByTitle(query, daysToSearch);
}
