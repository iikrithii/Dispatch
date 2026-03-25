const fetch = require("node-fetch");
const { getMockIssueBundle } = require("./jiraMockData");

const SEARCH_FIELDS = [
  "summary",
  "status",
  "assignee",
  "priority",
  "duedate",
  "updated",
  "labels",
  "parent",
  "project",
  "issuelinks",
  "comment",
];

const JIRA_SEARCH_PATH = "/rest/api/3/search/jql";

const STOP_WORDS = new Set([
  "with", "from", "this", "that", "have", "will", "been", "your",
  "meeting", "call", "sync", "review", "weekly", "update", "prep",
  "follow", "yesterday", "today", "about", "just", "also", "here",
  "some", "what", "when", "then", "only", "over", "very", "into",
  "more", "were", "they", "them", "their", "would", "could", "after",
  "before", "team", "check", "checkpoint",
]);

function normalizeTokens(text = "") {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function firstName(text = "") {
  return (text || "").trim().toLowerCase().split(/\s+/)[0] || "";
}

function escapeJqlText(text = "") {
  return (text || "").replace(/["\\]/g, "").trim();
}

function getBaseUrl() {
  return (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
}

function buildIssueUrl(key) {
  if (!key) return null;
  const baseUrl = getBaseUrl();
  return baseUrl ? `${baseUrl}/browse/${key}` : null;
}

function resolveJiraEmail(fallbackEmail = "") {
  return (process.env.JIRA_EMAIL || fallbackEmail || "").trim();
}

function hasLiveConfig(fallbackEmail = "") {
  return Boolean(
    getBaseUrl() &&
      resolveJiraEmail(fallbackEmail) &&
      process.env.JIRA_API_TOKEN
  );
}

function getAuthHeader(fallbackEmail = "") {
  const value = Buffer.from(
    `${resolveJiraEmail(fallbackEmail)}:${process.env.JIRA_API_TOKEN}`
  ).toString("base64");
  return `Basic ${value}`;
}

async function jiraFetch(path, options = {}) {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: getAuthHeader(options.fallbackEmail),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Jira API error [${res.status}] ${path}: ${error}`);
  }

  return res.json();
}

function buildSearchContext({
  event,
  pastMeeting,
  emails = [],
  attendeeEmails = [],
  attendeeNames = [],
}) {
  const subjectText = [event?.subject || "", pastMeeting?.subject || ""].join(" ");
  const emailText = emails
    .slice(0, 10)
    .flatMap((email) => [email.subject || "", email.bodyPreview || ""])
    .join(" ");

  const tokens = Array.from(
    new Set(normalizeTokens([subjectText, emailText].join(" ")))
  ).slice(0, 8);

  const attendeeHints = Array.from(
    new Set(
      []
        .concat(attendeeNames || [])
        .concat(attendeeEmails || [])
        .map((value) => (value || "").toLowerCase())
        .filter(Boolean)
    )
  );

  return { tokens, attendeeHints };
}

function extractIssueKeys({
  event,
  pastMeeting,
  emails = [],
}) {
  const text = [
    event?.subject || "",
    pastMeeting?.subject || "",
    ...emails.slice(0, 15).flatMap((email) => [email.subject || "", email.bodyPreview || ""]),
  ].join("\n");

  const matches = text.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/gi) || [];
  return Array.from(new Set(matches.map((value) => value.toUpperCase())));
}

function issueKeyProjectPrefixes(issueKeys = []) {
  return Array.from(
    new Set(
      issueKeys
        .map((key) => String(key).toUpperCase().split("-")[0])
        .filter(Boolean)
    )
  );
}

function getLatestCommentAt(fields = {}) {
  const comments = fields.comment?.comments || [];
  if (comments.length === 0) return null;
  return comments[comments.length - 1]?.updated || comments[comments.length - 1]?.created || null;
}

function normalizeIssue(rawIssue = {}) {
  const fields = rawIssue.fields || {};
  const spaceName = fields.project?.name || null;
  const projectLabel =
    fields.parent?.fields?.summary ||
    spaceName ||
    fields.project?.key ||
    null;

  const normalized = {
    key: rawIssue.key || null,
    title: fields.summary || rawIssue.key || "Untitled issue",
    status: fields.status?.name || "Unknown",
    assignee:
      fields.assignee?.displayName ||
      fields.assignee?.emailAddress ||
      "Unassigned",
    assigneeEmail: fields.assignee?.emailAddress || null,
    assigneeAccountId: fields.assignee?.accountId || null,
    priority: fields.priority?.name || "None",
    dueDate: fields.duedate || null,
    updatedAt: fields.updated || null,
    latestCommentAt: getLatestCommentAt(fields),
    labels: fields.labels || [],
    projectLabel,
    spaceName,
    parentTitle: fields.parent?.fields?.summary || null,
    issueLinks: fields.issuelinks || [],
    url: buildIssueUrl(rawIssue.key),
  };

  normalized.isBlocked = isBlockedIssue(normalized);
  return normalized;
}

function issueText(issue = {}) {
  return [
    issue.key,
    issue.title,
    issue.status,
    issue.assignee,
    issue.priority,
    issue.projectLabel,
    issue.parentTitle,
    issue.spaceName,
    ...(issue.labels || []),
  ].join(" ");
}

function isBlockedIssue(issue = {}) {
  const status = (issue.status || "").toLowerCase();
  const labels = (issue.labels || []).map((label) => String(label).toLowerCase());
  const linkText = (issue.issueLinks || [])
    .map((link) =>
      [
        link.type?.name,
        link.type?.inward,
        link.type?.outward,
        link.outwardIssue?.fields?.status?.name,
        link.outwardIssue?.fields?.summary,
        link.inwardIssue?.fields?.status?.name,
        link.inwardIssue?.fields?.summary,
      ].join(" ")
    )
    .join(" ")
    .toLowerCase();

  return (
    status.includes("block") ||
    labels.some((label) => label.includes("flagged") || label.includes("block")) ||
    linkText.includes("blocks") ||
    linkText.includes("blocked by")
  );
}

function isDoneStatus(status = "") {
  const value = (status || "").toLowerCase();
  return (
    value.includes("done") ||
    value.includes("closed") ||
    value.includes("resolved")
  );
}

function isTodoStatus(status = "") {
  const value = (status || "").toLowerCase();
  return value.includes("todo") || value.includes("to do") || value.includes("backlog");
}

function isActiveStatus(status = "") {
  return !isDoneStatus(status) && !isTodoStatus(status);
}

function getRecencyBoost(updatedAt) {
  if (!updatedAt) return 0;
  const updated = new Date(updatedAt).getTime();
  if (Number.isNaN(updated)) return 0;
  const ageMs = Date.now() - updated;
  if (ageMs <= 1000 * 60 * 60 * 24 * 3) return 2;
  if (ageMs <= 1000 * 60 * 60 * 24 * 7) return 1;
  return 0;
}

function scoreIssue(issue, { tokens = [], attendeeHints = [] }) {
  const issueTokens = new Set(normalizeTokens(issueText(issue)));
  const overlap = tokens.filter((token) => issueTokens.has(token)).length;
  const projectBoost = tokens.filter((token) =>
    normalizeTokens(issue.projectLabel || "").includes(token)
  ).length;

  const assigneeText = (issue.assignee || "").toLowerCase();
  const attendeeBoost = attendeeHints.some((hint) => {
    const value = hint.includes("@") ? hint.split("@")[0] : firstName(hint);
    return value && assigneeText.includes(value);
  })
    ? 2
    : 0;

  const blockerBoost = issue.isBlocked ? 3 : 0;
  const priorityBoost = /highest|high/.test((issue.priority || "").toLowerCase()) ? 1 : 0;

  return overlap * 3 + projectBoost * 2 + attendeeBoost + blockerBoost + priorityBoost + getRecencyBoost(issue.updatedAt);
}

async function searchRelevantIssues(input) {
  if (!hasLiveConfig(input.userEmail)) return [];

  const { tokens, attendeeHints } = buildSearchContext(input);
  const explicitIssueKeys = extractIssueKeys(input);
  const explicitProjectKeys = issueKeyProjectPrefixes(explicitIssueKeys);

  let exactIssues = [];
  if (explicitIssueKeys.length > 0) {
    const keyQuery = explicitIssueKeys
      .slice(0, 12)
      .map((key) => `"${escapeJqlText(key)}"`)
      .join(", ");

    const exactResponse = await jiraFetch(JIRA_SEARCH_PATH, {
      method: "POST",
      fallbackEmail: input.userEmail,
      body: JSON.stringify({
        jql: `issuekey in (${keyQuery}) ORDER BY updated DESC`,
        fields: SEARCH_FIELDS,
        maxResults: 20,
      }),
    });

    exactIssues = (exactResponse.issues || [])
      .map(normalizeIssue)
      .map((issue) => ({
        ...issue,
        score: scoreIssue(issue, { tokens, attendeeHints }) + 100,
      }));
  }

  if (tokens.length === 0) {
    return exactIssues
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
      })
      .slice(0, 8)
      .map(({ score, ...issue }) => issue);
  }

  const queryTerms = tokens
    .slice(0, 6)
    .map((token) => `text ~ "${escapeJqlText(token)}"`);

  const projectClause =
    explicitProjectKeys.length > 0
      ? `project in (${explicitProjectKeys.map((key) => `"${escapeJqlText(key)}"`).join(", ")}) AND `
      : "";

  const jql = `${projectClause}(${queryTerms.join(" OR ")}) ORDER BY updated DESC`;
  const response = await jiraFetch(JIRA_SEARCH_PATH, {
    method: "POST",
    fallbackEmail: input.userEmail,
    body: JSON.stringify({
      jql,
      fields: SEARCH_FIELDS,
      maxResults: 20,
    }),
  });

  const fuzzyIssues = (response.issues || [])
    .map(normalizeIssue)
    .map((issue) => ({
      ...issue,
      score: scoreIssue(issue, { tokens, attendeeHints }),
    }));

  const combined = new Map();
  for (const issue of exactIssues.concat(fuzzyIssues)) {
    const existing = combined.get(issue.key);
    if (!existing || issue.score > existing.score) {
      combined.set(issue.key, issue);
    }
  }

  return Array.from(combined.values())
    .filter((issue) => issue.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    })
    .slice(0, 8)
    .map(({ score, ...issue }) => issue);
}

function buildStatusSummary(issues = []) {
  const counts = issues.reduce(
    (acc, issue) => {
      if (issue.isBlocked) {
        acc.blocked += 1;
      } else if (isDoneStatus(issue.status)) {
        acc.done += 1;
      } else {
        acc.inProgress += 1;
      }
      return acc;
    },
    { done: 0, inProgress: 0, blocked: 0 }
  );

  const parts = [`${counts.done} done`, `${counts.inProgress} in progress`];
  if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
  return parts.join(", ");
}

function formatOwner(issue) {
  return issue.assignee && issue.assignee !== "Unassigned"
    ? issue.assignee
    : "an owner";
}

function buildOpenBlockers(issues = [], providedBlockers = []) {
  if (providedBlockers.length > 0) return providedBlockers.slice(0, 3);

  return issues
    .filter((issue) => issue.isBlocked)
    .slice(0, 3)
    .map((issue) => {
      const lower = (issue.title || "").toLowerCase();
      if (lower.includes("testimonial") || lower.includes("legal")) {
        return "Testimonial legal sign-off is still pending, so the testimonial section remains blocked for Phase 1.";
      }

      return `${issue.title} is blocked and currently sits with ${formatOwner(issue)}.`;
    });
}

function buildDiscussionPoints(issues = [], providedPoints = []) {
  if (providedPoints.length > 0) return providedPoints.slice(0, 4);

  const points = [];
  const blocker = issues.find((issue) => issue.isBlocked);
  const scopeDecision = issues.find((issue) => {
    const text = issueText(issue).toLowerCase();
    return text.includes("scope") || text.includes("launch") || text.includes("decision");
  });
  const highPriorityOpen = issues.find(
    (issue) =>
      !issue.isBlocked &&
      !isDoneStatus(issue.status) &&
      /highest|high/.test((issue.priority || "").toLowerCase())
  );

  if (blocker) {
    const lower = (blocker.title || "").toLowerCase();
    if (lower.includes("testimonial") || lower.includes("legal")) {
      points.push("Decide whether Phase 1 launches without testimonials while legal approval is still pending.");
    } else {
      points.push(`Unblock ${blocker.title} so execution can move again after the meeting.`);
    }
  }

  if (scopeDecision) {
    points.push(`${formatOwner(scopeDecision)} needs to confirm final scope before the handoff is packaged.`);
  }

  if (highPriorityOpen) {
    points.push(`Confirm owner and target date for ${highPriorityOpen.title.toLowerCase()} before the meeting ends.`);
  }

  if (points.length === 0 && issues.length > 0) {
    points.push("Review the remaining open Jira items and leave the meeting with a clear owner for each one.");
  }

  return Array.from(new Set(points)).slice(0, 4);
}

function buildIssueCard(issue = {}) {
  return {
    key: issue.key,
    title: issue.title,
    status: issue.status,
    assignee: issue.assignee,
    priority: issue.priority,
    dueDate: issue.dueDate,
    updatedAt: issue.updatedAt,
    url: issue.url,
    isBlocked: issue.isBlocked,
  };
}

function buildExecutionContext(issues = [], options = {}) {
  if (!issues.length) return null;

  const spaceName =
    options.spaceName ||
    issues.find((issue) => issue.spaceName)?.spaceName ||
    options.projectLabel ||
    issues.find((issue) => issue.projectLabel)?.projectLabel ||
    "Jira";

  return {
    title: "Jira Overview",
    spaceName,
    statusLine: buildStatusSummary(issues),
    blockers: buildOpenBlockers(issues, options.openBlockers || []),
    discussionPoints: buildDiscussionPoints(issues, options.discussionPoints || []),
    source: options.source || "live",
  };
}

async function buildPreCallExecutionContext(input) {
  let issues = [];
  let source = null;
  let mockBundle = null;

  if (hasLiveConfig(input.userEmail)) {
    try {
      issues = await searchRelevantIssues(input);
      if (issues.length > 0) {
        source = "live";
      }
    } catch (error) {
      console.error("[Jira] live search failed:", error && (error.stack || error.message || error));
      issues = [];
    }
  }

  if (issues.length === 0) {
    mockBundle = getMockIssueBundle(input);
    if (mockBundle) {
      issues = (mockBundle.issues || []).map((issue) => ({
        ...issue,
        assigneeEmail: issue.assigneeEmail || null,
        assigneeAccountId: issue.assigneeAccountId || null,
        latestCommentAt: issue.latestCommentAt || null,
        spaceName: issue.spaceName || mockBundle.spaceName || mockBundle.projectLabel || null,
        url: issue.url || buildIssueUrl(issue.key),
      }));
      source = "mock";
    }
  }

  const executionContext = buildExecutionContext(issues, {
    projectLabel: mockBundle?.projectLabel,
    spaceName: mockBundle?.spaceName,
    source,
    openBlockers: mockBundle?.openBlockers,
    discussionPoints: mockBundle?.discussionPoints,
  });

  return {
    executionContext,
    issues,
    meta: {
      enabled: Boolean(executionContext),
      source,
      matchedIssueCount: issues.length,
      liveConfigured: hasLiveConfig(input.userEmail),
    },
  };
}

module.exports = {
  buildIssueCard,
  hasLiveConfig,
  isActiveStatus,
  isDoneStatus,
  searchRelevantIssues,
  buildPreCallExecutionContext,
  normalizeTokens,
};
