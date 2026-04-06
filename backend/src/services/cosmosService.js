// services/cosmosService.js
// Merged: friend's richer saveMeetingRecord (preserves rich content, normalises attendees)
// + user's getRecentMeetingRecords (needed by getUnresolvedIssues).

const { CosmosClient } = require("@azure/cosmos");

let _client    = null;
let _container = null;

async function getContainer() {
  if (_container) return _container;
  _client = new CosmosClient({ endpoint: process.env.COSMOS_ENDPOINT, key: process.env.COSMOS_KEY });
  const dbId        = process.env.COSMOS_DATABASE || "dispatch";
  const containerId = process.env.COSMOS_CONTAINER || "tasks";
  const { database }  = await _client.databases.createIfNotExists({ id: dbId });
  const { container } = await database.containers.createIfNotExists({
    id: containerId,
    partitionKey: { paths: ["/userId"] },
    defaultTtl: 60 * 60 * 24 * 30,
  });
  _container = container;
  return _container;
}

// ─────────────────────────────────────────────
// PENDING ITEMS (Approval Queue)
// ─────────────────────────────────────────────

async function savePendingItems(userId, meetingId, items) {
  const container = await getContainer();
  const record = {
    id:        `pending_${meetingId}_${Date.now()}`,
    userId,
    meetingId,
    type:      "pending_batch",
    items:     items.map((item) => ({ ...item, status: "pending", createdAt: new Date().toISOString() })),
    createdAt: new Date().toISOString(),
  };
  const { resource } = await container.items.upsert(record);
  return resource;
}

async function getPendingItems(userId) {
  const container = await getContainer();
  const { resources } = await container.items.query({
    query:      `SELECT * FROM c WHERE c.userId = @userId AND c.type = 'pending_batch' ORDER BY c.createdAt DESC`,
    parameters: [{ name: "@userId", value: userId }],
  }).fetchAll();
  return resources;
}

async function updateItemStatus(userId, batchId, itemId, status) {
  const container       = await getContainer();
  const { resource: record } = await container.item(batchId, userId).read();
  record.items = record.items.map((item) =>
    item.id === itemId ? { ...item, status, resolvedAt: new Date().toISOString() } : item
  );
  const { resource: updated } = await container.item(batchId, userId).replace(record);
  return updated;
}

// ─────────────────────────────────────────────
// REMINDERS
// ─────────────────────────────────────────────

async function saveReminder(userId, { text, dueDate, meetingId, owner }) {
  const container = await getContainer();
  const record = {
    id: `reminder_${Date.now()}`, userId, type: "reminder",
    text, dueDate, meetingId, owner, status: "active", createdAt: new Date().toISOString(),
  };
  const { resource } = await container.items.upsert(record);
  return resource;
}

async function getActiveReminders(userId) {
  const container = await getContainer();
  const { resources } = await container.items.query({
    query:      `SELECT * FROM c WHERE c.userId = @userId AND c.type = 'reminder' AND c.status = 'active' ORDER BY c.dueDate`,
    parameters: [{ name: "@userId", value: userId }],
  }).fetchAll();
  return resources;
}

// ─────────────────────────────────────────────
// MEETING RECORDS — helpers
// ─────────────────────────────────────────────

function normalizeTokens(text = "") {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);
}

/**
 * A record is "rich" if it has real meeting content — not just a pre-call stub.
 * Rich records come from the seed script or from post-call processing.
 */
function hasRichMeetingContent(record = {}) {
  return !!(
    record?.transcript ||
    record?.summary    ||
    (Array.isArray(record?.actionItems) && record.actionItems.length > 0)
  );
}

/**
 * Normalise attendees to plain lowercase email strings.
 * Accepts: "Name <email>" strings, { emailAddress: { address } } objects, or plain email strings.
 */
function normalizeAttendees(attendees = []) {
  return (attendees || [])
    .map((value) => {
      if (!value) return null;
      if (typeof value === "string") {
        const match = value.match(/<([^>]+)>/);
        return (match ? match[1] : value).trim().toLowerCase();
      }
      if (value.emailAddress?.address) return String(value.emailAddress.address).trim().toLowerCase();
      return null;
    })
    .filter(Boolean);
}

function buildKeywords(data = {}, existing = {}) {
  const provided = Array.isArray(data.keywords) ? data.keywords.filter(Boolean) : [];
  if (provided.length > 0) return provided;
  const fallback = normalizeTokens([
    data.subject    || existing.subject    || "",
    data.summary    || existing.summary    || "",
    ...(data.keyDecisions || existing.keyDecisions || []),
  ].join(" "));
  return Array.from(new Set(fallback)).slice(0, 12);
}

// ─────────────────────────────────────────────
// MEETING RECORDS — queries
// ─────────────────────────────────────────────

async function getPreviousMeetings(userId, attendeeEmails, subjectKeywords, limit = 1) {
  const container = await getContainer();

  let resources = [];
  try {
    const { resources: byUser } = await container.items.query({
      query:      `SELECT TOP 100 * FROM c WHERE c.userId = @userId AND c.type = 'meeting_record' ORDER BY c.savedAt DESC`,
      parameters: [{ name: "@userId", value: userId }],
    }).fetchAll();
    resources = byUser;
  } catch { resources = []; }

  if (resources.length === 0) {
    try {
      const { resources: all } = await container.items.query({
        query: `SELECT TOP 100 * FROM c WHERE c.type = 'meeting_record' ORDER BY c.savedAt DESC`,
      }).fetchAll();
      resources = all;
    } catch { return []; }
  }

  if (!resources.length) return [];

  const subjectKw = (subjectKeywords || []).map((k) =>
    String(k || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim()
  );

  const scored = resources.map((r) => {
    const isRich = !!(r.transcript || (r.actionItems && r.actionItems.length > 0) || r.summary);
    let score = 0;

    const attendeeOverlap = (r.attendees || []).filter((a) =>
      attendeeEmails.map((e) => e.toLowerCase()).includes(a.toLowerCase())
    ).length;
    score += attendeeOverlap * 3;

    const meetingText = `${r.subject || ""} ${(r.keywords || []).join(" ")}`.toLowerCase();
    (subjectKw || []).forEach((kw) => { if (kw && meetingText.includes(kw)) score += 2; });

    normalizeTokens(r.subject || "").forEach((t) => {
      if ((subjectKw || []).some((kw) => kw.includes(t) || t.includes(kw))) score += 1;
    });

    return { ...r, _relevanceScore: score, _isRich: isRich };
  });

  const richAndRelevant = scored
    .filter((r) => r._isRich && r._relevanceScore > 0)
    .sort((a, b) => b._relevanceScore - a._relevanceScore);

  console.log("[getPreviousMeetings] richAndRelevant count:", richAndRelevant.length);
  if (richAndRelevant.length > 0) {
    console.log("[getPreviousMeetings] returning:", richAndRelevant[0].id);
    return richAndRelevant.slice(0, 1);
  }

  console.log("[getPreviousMeetings] no rich match found — returning empty");
  return [];
}

/**
 * Save a meeting record.
 *
 * Key behaviour (from friend's Jira branch — fixes the "everything gone on second click" bug):
 *   - Pre-call writes a LIGHTWEIGHT stub (briefGenerated: true only).
 *   - Post-call / seed writes RICH content (summary, transcript, actionItems…).
 *   - If a rich record already exists at this id, a pre-call stub NEVER overwrites it.
 *   - If a rich record comes in and an older rich record exists, the new one is merged in,
 *     preserving any existing content that the new write doesn't supply.
 */
async function saveMeetingRecord(userId, meetingId, data) {
  const container = await getContainer();
  const id        = `meeting_${meetingId}`;

  // Read existing record first (may 404 if new)
  let existing = null;
  try {
    const { resource } = await container.item(id, userId).read();
    existing = resource || null;
  } catch { existing = null; }

  const now           = new Date().toISOString();
  const incomingIsRich = hasRichMeetingContent(data);
  const existingIsRich = hasRichMeetingContent(existing);

  let record;

  if (!incomingIsRich) {
    // Pre-call stub — never overwrite an existing rich record
    record = existingIsRich
      ? {
          ...existing,
          briefGenerated:    true,
          briefGeneratedAt:  data.briefGeneratedAt || existing.briefGeneratedAt || now,
          savedAt:           now,
        }
      : {
          id, userId, meetingId, type: "meeting_record",
          briefGenerated:   true,
          briefGeneratedAt: data.briefGeneratedAt || now,
          savedAt:          now,
        };
  } else {
    // Rich record (post-call or seed) — merge with any existing rich content
    record = {
      ...(existing || {}),
      id, userId, meetingId, type: "meeting_record",
      subject:             data.subject             || existing?.subject             || null,
      attendees:           normalizeAttendees(data.attendees || existing?.attendees || []),
      date:                data.date                || existing?.date                || null,
      startTime:           data.startTime || data.date || existing?.startTime        || null,
      summary:             data.summary             || existing?.summary             || null,
      keyDecisions:        data.keyDecisions         || existing?.keyDecisions        || [],
      transcript:          data.transcript           || existing?.transcript           || null,
      actionItems:         (data.actionItems || existing?.actionItems || []).map((item) => ({
        ...item, status: item.status || "pending",
      })),
      plannedForNextMeeting: data.plannedForNextMeeting || existing?.plannedForNextMeeting || [],
      keywords:            buildKeywords(data, existing || {}),
      briefGenerated:      data.briefGenerated    || existing?.briefGenerated    || false,
      briefGeneratedAt:    data.briefGeneratedAt  || existing?.briefGeneratedAt  || null,
      savedAt:             now,
    };
  }

  const { resource } = await container.items.upsert(record);
  return resource;
}

// ─────────────────────────────────────────────
// USER SETTINGS
// ─────────────────────────────────────────────

async function getUserSettings(userId) {
  const container = await getContainer();
  try {
    const { resource } = await container.item(`settings_${userId}`, userId).read();
    return resource;
  } catch {
    return { userId, preCallMinutes: 5, nudgesEnabled: true };
  }
}

async function saveUserSettings(userId, settings) {
  const container = await getContainer();
  const record = { id: `settings_${userId}`, userId, type: "settings", ...settings };
  const { resource } = await container.items.upsert(record);
  return resource;
}

async function getPendingActionItemsForMeeting(userId, meetingId) {
  const container = await getContainer();
  try {
    const { resource } = await container.item(`meeting_${meetingId}`, userId).read();
    return (resource?.actionItems || []).filter((a) => a.status === "pending");
  } catch { return []; }
}

/**
 * Fetch the last N meeting records for a user.
 * Used by getUnresolvedIssues — bypasses getPreviousMeetings scoring
 * to get all recent records, not just the single best match.
 */
async function getRecentMeetingRecords(userId, limit = 10) {
  const container = await getContainer();
  const { resources } = await container.items.query({
    query: `SELECT TOP ${limit} * FROM c WHERE c.userId = @userId AND c.type = 'meeting_record' ORDER BY c.savedAt DESC`,
    parameters: [{ name: "@userId", value: userId }],
  }).fetchAll();
  return resources;
}

module.exports = {
  savePendingItems,
  getPendingItems,
  updateItemStatus,
  saveReminder,
  getActiveReminders,
  saveMeetingRecord,
  getPreviousMeetings,
  getPendingActionItemsForMeeting,
  getUserSettings,
  saveUserSettings,
  getRecentMeetingRecords,
};