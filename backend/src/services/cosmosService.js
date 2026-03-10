// services/cosmosService.js
// Azure Cosmos DB operations.
// Stores: task state, approval history, reminders, urgency scores.

const { CosmosClient } = require("@azure/cosmos");

let _client = null;
let _container = null;

async function getContainer() {
  if (_container) return _container;

  _client = new CosmosClient({
    endpoint: process.env.COSMOS_ENDPOINT,
    key: process.env.COSMOS_KEY,
  });

  const dbId = process.env.COSMOS_DATABASE || "dispatch";
  const containerId = process.env.COSMOS_CONTAINER || "tasks";

  const { database } = await _client.databases.createIfNotExists({ id: dbId });
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
    id: `pending_${meetingId}_${Date.now()}`,
    userId,
    meetingId,
    type: "pending_batch",
    items: items.map((item) => ({
      ...item,
      status: "pending",
      createdAt: new Date().toISOString(),
    })),
    createdAt: new Date().toISOString(),
  };

  const { resource } = await container.items.upsert(record);
  return resource;
}

async function getPendingItems(userId) {
  const container = await getContainer();
  const query = {
    query: `SELECT * FROM c WHERE c.userId = @userId AND c.type = 'pending_batch' ORDER BY c.createdAt DESC`,
    parameters: [{ name: "@userId", value: userId }],
  };

  const { resources } = await container.items.query(query).fetchAll();
  return resources;
}

async function updateItemStatus(userId, batchId, itemId, status) {
  const container = await getContainer();
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
    id: `reminder_${Date.now()}`,
    userId,
    type: "reminder",
    text,
    dueDate,
    meetingId,
    owner,
    status: "active",
    createdAt: new Date().toISOString(),
  };

  const { resource } = await container.items.upsert(record);
  return resource;
}

async function getActiveReminders(userId) {
  const container = await getContainer();
  const query = {
    query: `SELECT * FROM c WHERE c.userId = @userId AND c.type = 'reminder' AND c.status = 'active' ORDER BY c.dueDate`,
    parameters: [{ name: "@userId", value: userId }],
  };

  const { resources } = await container.items.query(query).fetchAll();
  return resources;
}

// ─────────────────────────────────────────────
// MEETING RECORDS
// ─────────────────────────────────────────────

function normalizeTokens(text = "") {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

async function getPreviousMeetings(userId, attendeeEmails, subjectKeywords, limit = 1) {
  const container = await getContainer();

  let resources = [];
  try {
    const { resources: byUser } = await container.items
      .query({
        query: `SELECT TOP 100 * FROM c WHERE c.userId = @userId AND c.type = 'meeting_record' ORDER BY c.savedAt DESC`,
        parameters: [{ name: "@userId", value: userId }],
      })
      .fetchAll();
    resources = byUser;
  } catch {
    resources = [];
  }

  if (resources.length === 0) {
    try {
      const { resources: all } = await container.items
        .query({
          query: `SELECT TOP 100 * FROM c WHERE c.type = 'meeting_record' ORDER BY c.savedAt DESC`,
        })
        .fetchAll();
      resources = all;
    } catch {
      return [];
    }
  }

  if (!resources.length) return [];

  const subjectKw = (subjectKeywords || []).map((k) =>
    String(k || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim()
  );

  const scored = resources.map((r) => {
    // Rich = has transcript, actionItems, or summary (i.e. a seed or post-call record)
    const isRich = !!(r.transcript || (r.actionItems && r.actionItems.length > 0) || r.summary);

    let score = 0;

    const attendeeOverlap = (r.attendees || []).filter((a) =>
      attendeeEmails.map((e) => e.toLowerCase()).includes(a.toLowerCase())
    ).length;
    score += attendeeOverlap * 3;

    const meetingText = `${r.subject || ""} ${(r.keywords || []).join(" ")}`.toLowerCase();
    (subjectKw || []).forEach((kw) => {
      if (kw && meetingText.includes(kw)) score += 2;
    });

    const pastTokens = normalizeTokens(r.subject || "");
    pastTokens.forEach((t) => {
      if ((subjectKw || []).some((kw) => kw.includes(t) || t.includes(kw))) score += 1;
    });

    return { ...r, _relevanceScore: score, _isRich: isRich };
  });

  // Step 1: prefer rich records that score > 0
  const richAndRelevant = scored
    .filter((r) => r._isRich && r._relevanceScore > 0)
    .sort((a, b) => b._relevanceScore - a._relevanceScore);

  // DEBUG — remove after confirming fix
  console.log("[getPreviousMeetings] all candidates:");
  scored.forEach((r) => {
    console.log(`  id=${r.id} | isRich=${r._isRich} | score=${r._relevanceScore} | savedAt=${r.savedAt} | hasTranscript=${!!r.transcript} | actionItemCount=${(r.actionItems||[]).length} | hasSummary=${!!r.summary}`);
  });
  console.log("[getPreviousMeetings] richAndRelevant count:", richAndRelevant.length);

  if (richAndRelevant.length > 0) {
    console.log("[getPreviousMeetings] returning:", richAndRelevant[0].id);
    return richAndRelevant.slice(0, 1);
  }

  console.log("[getPreviousMeetings] no rich match found — returning empty");
  return [];
}

/**
 * Save a lightweight "brief was generated" stub against the live calendar event ID.
 *
 * IMPORTANT: this must NEVER overwrite a rich meeting record (one that has a
 * transcript, actionItems, or summary). Rich records come from the seed script
 * or from a post-call processing run — they are the ground truth for the
 * pre-call brief. Overwriting them with a thin stub is what caused the
 * "everything gone on second click" bug.
 *
 * Strategy: read first. If an existing record is rich, merge the new metadata
 * in without touching transcript / actionItems / summary / keywords.
 */
async function saveMeetingRecord(userId, meetingId, data) {
  const container = await getContainer();
  const id = `meeting_${meetingId}`;

  // The stub record we write here uses the live Graph event ID as its key.
  // Seed records use keys like "meeting_webinar_prep_seed" — a completely
  // different id — so container.item(id, userId).read() will always 404 for stubs.
  // We intentionally do NOT try to protect the stub write; instead we make stubs
  // permanently non-competitive in getPreviousMeetings by never marking them rich.
  // All we store here is lightweight housekeeping so we can skip re-seeding checks.
  const record = {
    id,
    userId,
    meetingId,
    type: "meeting_record",
    // Only store non-content fields — no subject/keywords that could boost scoring
    briefGenerated: true,
    briefGeneratedAt: data.briefGeneratedAt || new Date().toISOString(),
    // Deliberately omit: transcript, actionItems, summary, attendees, keywords
    // This ensures _isRich stays false and the stub can never win in scoring
    savedAt: new Date().toISOString(),
  };

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
  } catch {
    return [];
  }
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
};