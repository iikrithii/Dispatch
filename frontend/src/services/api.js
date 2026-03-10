// src/services/api.js
// All calls to the Dispatch Azure Functions backend.

import { getAccessToken } from "./auth";

const API_BASE =
  process.env.REACT_APP_API_URL || "http://localhost:7071/api";

async function authFetch(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `API error ${res.status}`);
  }
  return data;
}

// ─────────────────────────────────────────────
// CALENDAR
// ─────────────────────────────────────────────

export const getEvents = () => authFetch("/events");

export const getPreMeetingBrief = (eventId) =>
  authFetch(`/pre-meeting-brief?eventId=${encodeURIComponent(eventId)}`);

// ─────────────────────────────────────────────
// POST-CALL
// ─────────────────────────────────────────────

export const processPostMeeting = (payload) =>
  authFetch("/post-meeting-process", {
    method: "POST",
    body: JSON.stringify(payload),
  });

// ─────────────────────────────────────────────
// EMAIL / THREAD
// ─────────────────────────────────────────────

export const getInbox = (limit = 20) =>
  authFetch(`/inbox?limit=${limit}`);

export const getThreadCatchup = (conversationId) =>
  authFetch("/thread-catchup", {
    method: "POST",
    body: JSON.stringify({ conversationId }),
  });

export const getProjectsSummary = (threads, events = []) =>
  authFetch("/projects-summary", {
    method: "POST",
    body: JSON.stringify({ threads, events }),
  });

// ─────────────────────────────────────────────
// DAILY
// ─────────────────────────────────────────────

export const getDailyTodos = () => authFetch("/daily-todos");

// ─────────────────────────────────────────────
// APPROVALS
// ─────────────────────────────────────────────

export const approveItem = (batchId, itemId, action) =>
  authFetch("/approve-item", {
    method: "POST",
    body: JSON.stringify({ batchId, itemId, action }),
  });