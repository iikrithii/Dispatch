// src/components/FocusGraphTab.jsx
// Focus Graph — Live Context Navigator
// Data source: getFocusGraph() for project list, getProjectDetails() for each project's content

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFocusGraph, getProjectDetails, getThreadCatchup } from "../services/api";

// ─── Constants ───────────────────────────────────────────────────────────────

const SCENE = { w: 2400, h: 1800 };

// Node type visual config
// - meeting: amber (was red, conflicted with overdue tasks)
// - person: violet (was green, conflicted with completed/on-track tasks)
const NODE_STYLE = {
  project: { color: "#111827", bg: "#f8fafc", border: "#94a3b8", ring: "#334155" },
  meeting: { color: "#92400e", bg: "#fffbeb", border: "#fcd34d", ring: "#f59e0b" },
  thread:  { color: "#854d0e", bg: "#fefce8", border: "#fde047", ring: "#eab308" },
  task:    { color: "#1e40af", bg: "#eff6ff", border: "#93c5fd", ring: "#3b82f6" },
  person:  { color: "#5b21b6", bg: "#f5f3ff", border: "#c4b5fd", ring: "#7c3aed" },
};

// Task urgency colors (override task node style)
const LANE_STYLE = {
  critical:  { dot: "#ef4444", bg: "#fff1f2", border: "#fca5a5", text: "#991b1b", label: "Overdue / Blocked" },
  attention: { dot: "#f97316", bg: "#fff7ed", border: "#fdba74", text: "#9a3412", label: "Due Soon" },
  watch:     { dot: "#eab308", bg: "#fefce8", border: "#fde047", text: "#854d0e", label: "This Week" },
  on_track:  { dot: "#22c55e", bg: "#f0fdf4", border: "#86efac", text: "#166534", label: "On Track" },
  waiting:   { dot: "#6b7280", bg: "#f9fafb", border: "#d1d5db", text: "#374151", label: "Waiting" },
};

// Cluster anchors relative to scene center
const CLUSTER = {
  meeting: { angle: -Math.PI / 2,       radius: 380 }, // top
  thread:  { angle: Math.PI,             radius: 380 }, // left
  task:    { angle: 0,                   radius: 380 }, // right
  person:  { angle: Math.PI / 2,         radius: 380 }, // bottom
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmt(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  } catch { return ""; }
}

function fmtDue(iso) {
  if (!iso) return "No deadline";
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = Math.round((d - now) / 86400000);
    if (diff < 0) return `Overdue by ${Math.abs(diff)}d`;
    if (diff === 0) return "Due today";
    if (diff === 1) return "Due tomorrow";
    return `Due ${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;
  } catch { return iso; }
}

function slugify(v = "") {
  return String(v).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "x";
}

// Normalize a person value (string "Name <email>", object, or plain string)
function normPerson(v) {
  if (!v) return null;
  let name = "", email = "";
  if (typeof v === "object") {
    name  = v.name  || v.displayName || "";
    email = (v.email || v.address || v.emailAddress?.address || "").toLowerCase().trim();
  } else {
    const m = String(v).match(/^(.+?)\s*<(.+?)>$/);
    if (m) { name = m[1].trim(); email = m[2].toLowerCase().trim(); }
    else if (v.includes("@")) { email = v.toLowerCase().trim(); }
    else { name = v.trim(); }
  }
  // Derive display name from email local part if name is blank
  if (!name && email) {
    name = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }
  if (!name && !email) return null;
  const key = email ? email.split("@")[0].replace(/[._-]+/g, "_") : slugify(name);
  return { name: name || email, email, key };
}

// Deduplicate people array
function dedupePeople(raw = []) {
  const map = new Map();
  for (const v of raw) {
    const p = normPerson(v);
    if (!p) continue;
    const existing = map.get(p.key);
    if (!existing) map.set(p.key, p);
    else if (!existing.name && p.name) map.set(p.key, { ...existing, name: p.name });
  }
  return Array.from(map.values());
}

// ─── Task Deduplication ───────────────────────────────────────────────────────

/**
 * Normalize text for similarity comparison: lowercase, remove punctuation,
 * split to tokens, filter short words.
 */
function tokenize(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2);
}

/**
 * Jaccard similarity between two token sets.
 * Returns 0–1. Threshold of 0.35 catches near-duplicates.
 */
function jaccardSim(a = [], b = []) {
  const sa = new Set(a);
  const sb = new Set(b);
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Given a list of Jira task titles and a meeting task title,
 * returns true if the meeting task is likely a duplicate of any Jira task.
 */
function isDuplicateOfJira(meetingTaskLabel = "", jiraTitles = []) {
  const meetingTokens = tokenize(meetingTaskLabel);
  for (const jiraTitle of jiraTitles) {
    const jiraTokens = tokenize(jiraTitle);
    if (jaccardSim(meetingTokens, jiraTokens) >= 0.35) return true;
  }
  return false;
}

// ─── Graph Builder ────────────────────────────────────────────────────────────

function buildGraph(projectOption, detail, focusGraphData) {
  // projectOption: { id, name, status, summary, threadId, nextMeetingId, counts }
  // detail: { meetings[], pendingTasks[], attendees[], emailThreads[] }
  // focusGraphData: the full getFocusGraph response (for task urgency etc.)

  const nodes = new Map(); // id → node
  const edges = [];        // { id, from, to, relation }

  const addNode = (id, type, label, metadata = {}) => {
    if (!nodes.has(id)) nodes.set(id, { id, type, label, metadata, connections: [] });
  };
  const addEdge = (from, to, relation) => {
    if (!nodes.has(from) || !nodes.has(to)) return;
    const id = `${from}--${to}`;
    if (edges.find(e => e.id === id)) return;
    edges.push({ id, from, to, relation });
    const fn = nodes.get(from); fn.connections = [...new Set([...fn.connections, to])];
    const tn = nodes.get(to);   tn.connections = [...new Set([...tn.connections, from])];
  };

  const projId = `proj:${projectOption.id}`;
  addNode(projId, "project", projectOption.name, {
    summary: projectOption.summary || "",
    status:  projectOption.status  || "on track",
    threadId: projectOption.threadId,
    nextMeetingId: projectOption.nextMeetingId,
  });

  // ── FocusGraph Jira tasks (highest priority, no dedup needed) ──
  // Collect Jira task titles first so we can deduplicate meeting tasks against them.
  const fgTasks = (focusGraphData?.tasks || []).filter(t => t.projectName === projectOption.name);
  const jiraTasks = fgTasks.filter(t => t.sourceKey === "jira");
  const jiraTitles = jiraTasks.map(t => t.title);

  for (const t of fgTasks) {
    const tid = `task:fg:${slugify(t.id || t.title || "").slice(0, 40)}`;
    if (nodes.has(tid)) continue;
    addNode(tid, "task", t.title, {
      owner: t.ownerName,
      dueDate: t.dueDate,
      lane: t.lane || "on_track",
      source: t.sourceLabel,
      status: t.statusText,
      description: t.description || t.contextSnippet || "",
      jiraKey: t.context?.jira?.key,
      jiraUrl: t.context?.jira?.url,
      isMine: t.isMine,
      waitingOnOthers: t.waitingOnOthers,
    });
    addEdge(tid, projId, "belongs_to");
    // Link task → thread
    const taskThread = t.context?.thread;
    if (taskThread?.conversationId) {
      const linkedTid = `thread:${slugify(taskThread.conversationId)}`;
      if (nodes.has(linkedTid)) addEdge(tid, linkedTid, "came_from");
    }
    // Link task → meeting
    const taskMeeting = t.context?.meeting;
    if (taskMeeting?.subject) {
      const linkedMid = `meeting:${slugify(taskMeeting.id || taskMeeting.subject)}`;
      if (nodes.has(linkedMid)) addEdge(tid, linkedMid, "created_in");
    }
  }

  // ── Meetings ──
  for (const m of (detail?.meetings || [])) {
    const mid = `meeting:${slugify(m.id || m.subject)}`;
    addNode(mid, "meeting", m.subject || "(Untitled meeting)", {
      date: m.date,
      summary: m.summary,
      actionItems: m.actionItems || [],
      attendees: m.attendees || [],
    });
    addEdge(mid, projId, "belongs_to");

    // Tasks from this meeting — skip if overlaps with a Jira task
    for (const ai of (m.actionItems || [])) {
      if (!ai.task) continue;
      if (isDuplicateOfJira(ai.task, jiraTitles)) continue; // deduplicate
      const tid = `task:meeting:${mid}:${slugify(ai.task).slice(0, 30)}`;
      const lane = ai.urgency === "high" ? "critical" : ai.urgency === "medium" ? "watch" : "on_track";
      addNode(tid, "task", ai.task, {
        owner: ai.owner,
        dueDate: ai.deadline,
        lane,
        source: "Meeting action item",
        status: ai.status || "pending",
        meetingSubject: m.subject,
        description: ai.task,
      });
      addEdge(tid, mid, "created_in");
      addEdge(tid, projId, "belongs_to");
    }
  }

  // ── Threads ──
  for (const t of (detail?.emailThreads || [])) {
    const tid = `thread:${slugify(t.conversationId || t.subject)}`;
    addNode(tid, "thread", t.subject || "(No subject)", {
      conversationId: t.conversationId,
      latestDate: t.latestDate,
      messageCount: t.messageCount,
      preview: t.bodyPreview || "",
      participants: t.participantNames || [],
    });
    addEdge(tid, projId, "belongs_to");
  }

  // ── Pending Tasks (from approval queue) — skip Jira duplicates ──
  for (const t of (detail?.pendingTasks || [])) {
    const label = t.label || t.data?.title || "Pending task";
    if (isDuplicateOfJira(label, jiraTitles)) continue; // deduplicate
    const tid = `task:pending:${slugify(t.id || t.label || "").slice(0, 30)}`;
    addNode(tid, "task", label, {
      owner: t.data?.owner || t.data?.person || null,
      dueDate: t.data?.deadline || null,
      lane: "watch",
      source: t.type === "email" ? "Email follow-up" : t.type === "calendar" ? "Calendar" : t.type === "reminder" ? "Reminder" : "Dispatch task",
      status: "pending",
      description: t.data?.commitment || t.data?.body || t.label || "",
      urgencyText: t.data?.urgency,
    });
    addEdge(tid, projId, "belongs_to");
  }

  // ── People ──
  const peopleRaw = dedupePeople(detail?.attendees?.map(a => ({ name: a.name, email: a.email })) || []);
  for (const p of peopleRaw) {
    const pid = `person:${p.key}`;
    addNode(pid, "person", p.name, {
      email: p.email,
      taskCount: detail?.attendees?.find(a => (a.email || "").includes(p.key))?.taskCount || 0,
    });
    addEdge(pid, projId, "involved_in");
  }

  return {
    projectId: projId,
    projectName: projectOption.name,
    nodes: Array.from(nodes.values()),
    nodeMap: Object.fromEntries(nodes),
    edges,
  };
}

// ─── Layout ───────────────────────────────────────────────────────────────────

function computeLayout(nodes, focusedId) {
  const cx = SCENE.w / 2, cy = SCENE.h / 2;
  const pos = {};
  const focusNode = nodes.find(n => n.id === focusedId);
  if (!focusNode) {
    // Default: project at center
    for (const n of nodes) pos[n.id] = { x: cx, y: cy };
    return pos;
  }

  pos[focusedId] = { x: cx, y: cy };

  if (focusNode.type === "project") {
    // Cluster connected nodes around center by type
    const byType = {};
    for (const n of nodes) {
      if (n.id === focusedId) continue;
      if (!byType[n.type]) byType[n.type] = [];
      byType[n.type].push(n);
    }
    for (const [type, group] of Object.entries(byType)) {
      const cluster = CLUSTER[type];
      if (!cluster) continue;
      const spread = Math.min(Math.PI * 0.65, (group.length - 1) * 0.35);
      const startAngle = cluster.angle - spread / 2;
      group.forEach((n, i) => {
        const angle = group.length === 1 ? cluster.angle : startAngle + (spread / Math.max(1, group.length - 1)) * i;
        // Vary radius slightly by index to avoid stacking
        const r = cluster.radius + (i % 2 === 0 ? 0 : 60) + Math.floor(i / 4) * 80;
        pos[n.id] = {
          x: cx + Math.cos(angle) * r,
          y: cy + Math.sin(angle) * r,
        };
      });
    }
  } else {
    // Focused on a non-project node: center it, surround with its neighbors
    const connected = new Set(focusNode.connections || []);
    const connectedNodes = nodes.filter(n => n.id !== focusedId && connected.has(n.id));
    const otherNodes = nodes.filter(n => n.id !== focusedId && !connected.has(n.id));

    connectedNodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, connectedNodes.length) - Math.PI / 2;
      pos[n.id] = { x: cx + Math.cos(angle) * 310, y: cy + Math.sin(angle) * 310 };
    });
    // Place disconnected nodes further out, faded
    otherNodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, otherNodes.length);
      pos[n.id] = { x: cx + Math.cos(angle) * 620, y: cy + Math.sin(angle) * 620 };
    });
  }

  return pos;
}

// ─── Focus State ─────────────────────────────────────────────────────────────

function getFocusState(graph, focusedId) {
  if (!graph) return { focusNode: null, visible: new Set(), dimmed: new Set() };
  const focusNode = graph.nodeMap[focusedId] || graph.nodes.find(n => n.type === "project");
  if (!focusNode) return { focusNode: null, visible: new Set(), dimmed: new Set() };

  const visible = new Set([focusNode.id]);
  (focusNode.connections || []).forEach(id => visible.add(id));

  const dimmed = new Set(graph.nodes.filter(n => !visible.has(n.id)).map(n => n.id));
  return { focusNode, visible, dimmed };
}

// ─── Node Component ───────────────────────────────────────────────────────────

function GraphNode({ node, pos, isActive, isDimmed, onMouseDown }) {
  const style = node.type === "task"
    ? (() => { const l = LANE_STYLE[node.metadata.lane] || LANE_STYLE.on_track; return { color: l.text, bg: l.bg, border: l.border, ring: l.dot }; })()
    : NODE_STYLE[node.type] || NODE_STYLE.project;

  const typeLabel = node.type === "task"
    ? (LANE_STYLE[node.metadata.lane]?.label || "Task")
    : node.type.charAt(0).toUpperCase() + node.type.slice(1);

  const meta = (() => {
    if (node.type === "meeting") return fmt(node.metadata.date);
    if (node.type === "thread")  return fmt(node.metadata.latestDate);
    if (node.type === "task")    return fmtDue(node.metadata.dueDate);
    if (node.type === "project") return node.metadata.status || "on track";
    return "";
  })();

  // Person nodes show name + email handle on separate lines
  const personEmail = node.type === "person" && node.metadata.email
    ? node.metadata.email
    : null;

  const isProject = node.type === "project";

  return (
    <div
      className={`fg-node fg-node--${node.type} ${isActive ? "fg-node--active" : ""} ${isDimmed ? "fg-node--dimmed" : ""}`}
      style={{
        left: pos.x,
        top:  pos.y,
        "--node-bg":     style.bg,
        "--node-border": isActive ? style.ring : style.border,
        "--node-color":  style.color,
        "--node-ring":   style.ring,
        width: isProject ? 160 : 140,
      }}
      onMouseDown={onMouseDown}
    >
      {node.type === "task" && (
        <span className="fg-node__dot" style={{ background: style.ring }} />
      )}
      <div className="fg-node__type">{typeLabel}</div>
      <div className="fg-node__label">{node.label}</div>
      {personEmail && (
        <div className="fg-node__email">{personEmail}</div>
      )}
      {meta && node.type !== "person" && <div className="fg-node__meta">{meta}</div>}
    </div>
  );
}

// ─── Side Panel ───────────────────────────────────────────────────────────────

function SidePanel({ node, graph, threadState, onGoDeeper, onCopyReply }) {
  if (!node) {
    return (
      <div className="fg-panel__empty">
        <div className="fg-panel__empty-icon">←</div>
        <div>Click any node to explore context</div>
      </div>
    );
  }

  return (
    <div className="fg-panel__content">
      {node.type === "project" && <ProjectPanel node={node} graph={graph} onGoDeeper={onGoDeeper} />}
      {node.type === "thread"  && <ThreadPanel node={node} threadState={threadState} onCopyReply={onCopyReply} graph={graph} />}
      {node.type === "meeting" && <MeetingPanel node={node} graph={graph} />}
      {node.type === "person"  && <PersonPanel node={node} graph={graph} />}
    </div>
  );
}

function PanelSection({ title, children }) {
  return (
    <div className="fg-panel__section">
      <div className="fg-panel__section-title">{title}</div>
      <div className="fg-panel__section-body">{children}</div>
    </div>
  );
}

function ProjectPanel({ node, graph, onGoDeeper }) {
  const taskNodes = graph.nodes.filter(n => n.type === "task");
  const byLane = {};
  for (const t of taskNodes) byLane[t.metadata.lane] = (byLane[t.metadata.lane] || 0) + 1;

  const status = byLane.critical > 0 ? "🔴 Blocked" : byLane.attention > 0 ? "🟠 At risk" : byLane.watch > 0 ? "🟡 Watching" : "🟢 On track";

  return (
    <>
      <div className="fg-panel__kicker">Project</div>
      <div className="fg-panel__title">{node.label}</div>
      <div className="fg-panel__status">{status}</div>

      <PanelSection title="Summary">
        {node.metadata.summary || <span className="fg-muted">No summary available.</span>}
      </PanelSection>

      <PanelSection title="Task breakdown">
        {Object.entries(LANE_STYLE).map(([lane, s]) => byLane[lane] ? (
          <div key={lane} className="fg-panel__lane-row">
            <span className="fg-panel__lane-dot" style={{ background: s.dot }} />
            <span>{s.label}</span>
            <span className="fg-panel__lane-count">{byLane[lane]}</span>
          </div>
        ) : null)}
        {!taskNodes.length && <span className="fg-muted">No tasks found.</span>}
      </PanelSection>

      <PanelSection title="People involved">
        {graph.nodes.filter(n => n.type === "person").slice(0, 8).map(p => (
          <div key={p.id} className="fg-panel__person-row">
            <span className="fg-panel__avatar">{(p.label || "?")[0].toUpperCase()}</span>
            <div className="fg-panel__person-info">
              <span className="fg-panel__person-name">{p.label}</span>
              {p.metadata.email && (
                <span className="fg-panel__person-email">{p.metadata.email}</span>
              )}
            </div>
          </div>
        ))}
        {!graph.nodes.filter(n => n.type === "person").length && <span className="fg-muted">No people surfaced.</span>}
      </PanelSection>

      <div className="fg-panel__actions">
        <button
          className="fg-btn fg-btn--primary"
          onClick={() => onGoDeeper({ projectName: node.label, threadId: node.metadata.threadId, nextMeetingId: node.metadata.nextMeetingId })}
        >
          Open full project view →
        </button>
      </div>
    </>
  );
}

function ThreadPanel({ node, threadState, onCopyReply, graph }) {
  const { conversationId, participants, latestDate, messageCount } = node.metadata;
  const catchup = threadState?.data?.catchup;
  const relatedTasks = graph.nodes.filter(n => n.type === "task" && n.connections?.includes(node.id));

  return (
    <>
      <div className="fg-panel__kicker">Email Thread</div>
      <div className="fg-panel__title">{node.label}</div>

      <PanelSection title="Thread info">
        <div className="fg-panel__info-row"><span>Participants</span><span>{(participants || []).join(", ") || "Unknown"}</span></div>
        <div className="fg-panel__info-row"><span>Last activity</span><span>{fmt(latestDate) || "Unknown"}</span></div>
        {messageCount && <div className="fg-panel__info-row"><span>Messages</span><span>{messageCount}</span></div>}
      </PanelSection>

      <PanelSection title="Summary">
        {threadState?.loading ? (
          <span className="fg-muted">Loading thread summary…</span>
        ) : catchup ? (
          <div className="fg-panel__thread-summary">
            {catchup.whatThisIsAbout && <div><strong>What:</strong> {catchup.whatThisIsAbout}</div>}
            {catchup.whereItStandsNow && <div><strong>Now:</strong> {catchup.whereItStandsNow}</div>}
            {catchup.whatIsExpectedOfYou && <div><strong>You need to:</strong> {catchup.whatIsExpectedOfYou}</div>}
          </div>
        ) : (
          <span className="fg-muted">{node.metadata.preview || "No thread summary available."}</span>
        )}
      </PanelSection>

      <PanelSection title="Commitments from this thread">
        {relatedTasks.length ? relatedTasks.map(t => (
          <div key={t.id} className="fg-panel__task-row">
            <span className="fg-panel__lane-dot" style={{ background: (LANE_STYLE[t.metadata.lane] || LANE_STYLE.on_track).dot }} />
            {t.label}
          </div>
        )) : <span className="fg-muted">No tasks linked to this thread.</span>}
      </PanelSection>

      {catchup?.suggestedReply && (
        <div className="fg-panel__actions">
          <button className="fg-btn fg-btn--primary" onClick={() => onCopyReply(catchup.suggestedReply)}>
            Draft reply
          </button>
        </div>
      )}
    </>
  );
}

function MeetingPanel({ node, graph }) {
  const { date, summary, actionItems = [], attendees = [] } = node.metadata;
  const open = actionItems.filter(a => a.status !== "done");
  const done = actionItems.filter(a => a.status === "done");
  const relatedTasks = graph.nodes.filter(n => n.type === "task" && n.connections?.includes(node.id));

  return (
    <>
      <div className="fg-panel__kicker">Meeting</div>
      <div className="fg-panel__title">{node.label}</div>

      <PanelSection title="Meeting info">
        <div className="fg-panel__info-row"><span>Date</span><span>{fmt(date) || "Unknown"}</span></div>
        <div className="fg-panel__info-row">
          <span>Attendees</span>
          <span>{attendees.slice(0, 4).map(a => typeof a === "string" ? a.replace(/<.*?>/, "").trim() : a.name || a).join(", ") || "Unknown"}</span>
        </div>
      </PanelSection>

      <PanelSection title="Discussion summary">
        {summary || <span className="fg-muted">No meeting summary available. Run post-call processing to populate.</span>}
      </PanelSection>

      <PanelSection title="Decisions made">
        {done.length ? done.map((a, i) => (
          <div key={i} className="fg-panel__task-row">
            <span className="fg-panel__check">✓</span> {a.task}
          </div>
        )) : <span className="fg-muted">No explicit decisions recorded.</span>}
      </PanelSection>

      <PanelSection title="Open items">
        {open.length ? open.map((a, i) => (
          <div key={i} className="fg-panel__task-row">
            <span className="fg-panel__owner">{a.owner || "?"}:</span> {a.task}
          </div>
        )) : <span className="fg-muted">No open items from this meeting.</span>}
      </PanelSection>

      <PanelSection title="Follow-up tasks">
        {relatedTasks.length ? relatedTasks.map(t => (
          <div key={t.id} className="fg-panel__task-row">
            <span className="fg-panel__lane-dot" style={{ background: (LANE_STYLE[t.metadata.lane] || LANE_STYLE.on_track).dot }} />
            {t.label}
          </div>
        )) : <span className="fg-muted">No follow-up tasks linked.</span>}
      </PanelSection>
    </>
  );
}

function PersonPanel({ node, graph }) {
  const { email, taskCount } = node.metadata;
  const ownedTasks   = graph.nodes.filter(n => n.type === "task" && n.metadata.owner === node.label);
  const blockingMe   = graph.nodes.filter(n => n.type === "task" && n.metadata.waitingOnOthers && n.metadata.owner === node.label);
  const theirThreads = graph.nodes.filter(n => n.type === "thread" && (n.metadata.participants || []).includes(node.label));
  const theirMtgs    = graph.nodes.filter(n => n.type === "meeting" && (n.metadata.attendees || []).some(a => String(a).includes(node.label)));

  return (
    <>
      <div className="fg-panel__kicker">Person</div>
      <div className="fg-panel__title">{node.label}</div>
      {email && <div className="fg-muted" style={{ fontSize: 12, marginBottom: 12 }}>{email}</div>}

      <PanelSection title="Open items they own">
        {ownedTasks.length ? ownedTasks.slice(0, 6).map(t => (
          <div key={t.id} className="fg-panel__task-row">
            <span className="fg-panel__lane-dot" style={{ background: (LANE_STYLE[t.metadata.lane] || LANE_STYLE.on_track).dot }} />
            {t.label}
          </div>
        )) : <span className="fg-muted">No tasks assigned to this person.</span>}
      </PanelSection>

      <PanelSection title="Blocking my work">
        {blockingMe.length ? blockingMe.map(t => (
          <div key={t.id} className="fg-panel__task-row" style={{ color: "#ef4444" }}>
            ⚠ {t.label}
          </div>
        )) : <span className="fg-muted">Nothing blocked by this person.</span>}
      </PanelSection>

      {theirThreads.length > 0 && (
        <PanelSection title="Related threads">
          {theirThreads.slice(0, 4).map(t => (
            <div key={t.id} className="fg-panel__info-row"><span>{t.label}</span></div>
          ))}
        </PanelSection>
      )}

      {theirMtgs.length > 0 && (
        <PanelSection title="Meetings together">
          {theirMtgs.slice(0, 4).map(m => (
            <div key={m.id} className="fg-panel__info-row"><span>{m.label}</span><span>{fmt(m.metadata.date)}</span></div>
          ))}
        </PanelSection>
      )}
    </>
  );
}

// ─── Task Modal ───────────────────────────────────────────────────────────────

function TaskModal({ node, onClose }) {
  if (!node) return null;
  const t = node.metadata;
  const lane = LANE_STYLE[t.lane] || LANE_STYLE.on_track;

  return (
    <div className="fg-modal-backdrop" onClick={onClose}>
      <div className="fg-modal" onClick={e => e.stopPropagation()}>
        <button className="fg-modal__close" onClick={onClose}>✕</button>
        <div className="fg-panel__kicker" style={{ color: lane.text }}>Task · {lane.label}</div>
        <div className="fg-modal__title">{node.label}</div>

        <div className="fg-modal__grid">
          <div><span>Assigned to</span><strong>{t.owner || "Unassigned"}</strong></div>
          <div><span>Source</span><strong>{t.source || "Unknown"}</strong></div>
          <div><span>Status</span><strong>{t.status || "Open"}</strong></div>
          <div><span>Deadline</span><strong>{fmtDue(t.dueDate)}</strong></div>
          {t.jiraKey && <div><span>Jira</span><strong>{t.jiraKey}</strong></div>}
        </div>

        <div className="fg-modal__section">
          <div className="fg-modal__section-title">What needs to be done</div>
          <div className="fg-modal__section-body">{t.description || node.label}</div>
        </div>

        {(t.meetingSubject || t.jiraKey) && (
          <div className="fg-modal__section">
            <div className="fg-modal__section-title">Context</div>
            {t.meetingSubject && <div className="fg-panel__info-row"><span>From meeting</span><span>{t.meetingSubject}</span></div>}
            {t.jiraKey && t.jiraUrl && <div className="fg-panel__info-row"><span>Jira link</span><a href={t.jiraUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{t.jiraKey}</a></div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="fg-legend">
      {[
        { label: "Project",         color: NODE_STYLE.project.ring },
        { label: "Meeting",         color: NODE_STYLE.meeting.ring },
        { label: "Thread",          color: NODE_STYLE.thread.ring  },
        { label: "Person",          color: NODE_STYLE.person.ring  },
        { label: "Overdue/Blocked", color: LANE_STYLE.critical.dot },
        { label: "Due Soon",        color: LANE_STYLE.attention.dot},
        { label: "This Week",       color: LANE_STYLE.watch.dot    },
        { label: "On Track",        color: LANE_STYLE.on_track.dot },
        { label: "Waiting",         color: LANE_STYLE.waiting.dot  },
      ].map(({ label, color }) => (
        <div key={label} className="fg-legend__item">
          <span className="fg-legend__dot" style={{ background: color }} />
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function FocusGraphTab({ onGoDeeper }) {
  // ── State ──
  const [listData,    setListData]    = useState(null);  // getFocusGraph result
  const [loadingList, setLoadingList] = useState(true);
  const [listError,   setListError]   = useState(null);

  const [projectName, setProjectName] = useState("");
  const [detail,      setDetail]      = useState(null);  // getProjectDetails result
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [filters, setFilters] = useState({
    person: "", source: "all", urgency: "all", ownership: "all", timeRange: 14,
  });

  const [focusedId,   setFocusedId]   = useState("");
  const [taskModalId, setTaskModalId] = useState("");
  const [panelOpen,   setPanelOpen]   = useState(true);

  const [threadCache, setThreadCache] = useState({});
  const [viewport,    setViewport]    = useState({ x: 0, y: 0, scale: 0.75 });
  const [positions,   setPositions]   = useState({});
  const [manualPos,   setManualPos]   = useState({});

  const canvasRef = useRef(null);
  const dragRef   = useRef(null);
  const animRef   = useRef(null);

  // ── Load project list ──
  useEffect(() => {
    let dead = false;
    (async () => {
      setLoadingList(true);
      try {
        const res = await getFocusGraph();
        if (!dead) {
          setListData(res);
          const first = res.meta?.projectOptions?.[0]?.name || "";
          setProjectName(first);
        }
      } catch (e) {
        if (!dead) setListError(e.message);
      } finally {
        if (!dead) setLoadingList(false);
      }
    })();
    return () => { dead = true; };
  }, []);

  // ── Load project detail when project changes ──
  useEffect(() => {
    if (!projectName || !listData) return;
    const opt = listData.meta?.projectOptions?.find(o => o.name === projectName);
    if (!opt) return;

    let dead = false;
    setDetail(null);
    setLoadingDetail(true);
    setFocusedId("");
    setManualPos({});

    (async () => {
      try {
        const res = await getProjectDetails(opt.threadId || "", opt.name, opt.nextMeetingId || "");
        if (!dead) setDetail(res);
      } catch (e) {
        console.warn("[FocusGraph] getProjectDetails failed:", e.message);
        if (!dead) setDetail({ meetings: [], pendingTasks: [], attendees: [], emailThreads: [] });
      } finally {
        if (!dead) setLoadingDetail(false);
      }
    })();
    return () => { dead = true; };
  }, [projectName, listData]);

  // ── Build graph ──
  const projectOpt = listData?.meta?.projectOptions?.find(o => o.name === projectName);
  const graph = useMemo(() => {
    if (!projectOpt || !detail) return null;
    return buildGraph(projectOpt, detail, listData);
  }, [projectOpt, detail, listData]);

  // ── Focus state ──
  const effectiveFocusId = focusedId || graph?.projectId || "";
  const focusState = useMemo(() => getFocusState(graph, effectiveFocusId), [graph, effectiveFocusId]);

  // ── Filter highlight set ──
  const highlightSet = useMemo(() => {
    if (!graph) return new Set();
    const anyActive = filters.person || filters.source !== "all" || filters.urgency !== "all" || filters.ownership !== "all";
    if (!anyActive) return new Set(graph.nodes.map(n => n.id));
    const s = new Set([graph.projectId]);
    for (const n of graph.nodes) {
      let match = false;
      if (filters.person && n.type === "person" && n.label === filters.person) match = true;
      if (filters.source !== "all" && n.type === filters.source) match = true;
      if (filters.urgency !== "all" && n.type === "task" && n.metadata.lane === filters.urgency) match = true;
      if (filters.ownership === "mine"      && n.type === "task" && n.metadata.isMine) match = true;
      if (filters.ownership === "delegated" && n.type === "task" && n.metadata.waitingOnOthers) match = true;
      if (match) { s.add(n.id); (n.connections || []).forEach(id => s.add(id)); }
    }
    return s;
  }, [graph, filters]);

  // ── Compute layout ──
  useEffect(() => {
    if (!graph) return;
    const target = computeLayout(graph.nodes, effectiveFocusId);
    // Animate towards target positions
    const animate = () => {
      setPositions(prev => {
        const next = { ...prev };
        let moving = false;
        for (const id of Object.keys(target)) {
          const t = manualPos[id] || target[id];
          const p = prev[id] || t;
          const dx = t.x - p.x, dy = t.y - p.y;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
            next[id] = t;
          } else {
            next[id] = { x: p.x + dx * 0.18, y: p.y + dy * 0.18 };
            moving = true;
          }
        }
        if (moving) animRef.current = requestAnimationFrame(animate);
        return next;
      });
    };
    cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [graph, effectiveFocusId, manualPos]);

  // ── Center viewport on focus node ──
  useEffect(() => {
    if (!canvasRef.current || !effectiveFocusId) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const pos  = computeLayout(graph?.nodes || [], effectiveFocusId)[effectiveFocusId];
    if (!pos) return;
    setViewport(v => ({
      ...v,
      x: rect.width  / 2 - pos.x * v.scale,
      y: rect.height / 2 - pos.y * v.scale,
    }));
  }, [effectiveFocusId, graph?.projectId]);

  // ── Auto-load thread summary when thread node is focused ──
  useEffect(() => {
    const node = focusState.focusNode;
    if (!node || node.type !== "thread") return;
    const cid = node.metadata.conversationId;
    if (!cid || threadCache[cid]) return;
    let dead = false;
    setThreadCache(c => ({ ...c, [cid]: { loading: true } }));
    getThreadCatchup(cid).then(res => {
      if (!dead) setThreadCache(c => ({ ...c, [cid]: { loading: false, data: res } }));
    }).catch(() => {
      if (!dead) setThreadCache(c => ({ ...c, [cid]: { loading: false, data: null } }));
    });
    return () => { dead = true; };
  }, [focusState.focusNode?.id]);

  // ── Pan / zoom handlers ──
  const handleWheel = useCallback(e => {
    e.preventDefault();
    const d = e.deltaY > 0 ? -0.07 : 0.07;
    setViewport(v => ({ ...v, scale: Math.max(0.35, Math.min(2, v.scale + d)) }));
  }, []);

  const handleCanvasDown = useCallback(e => {
    if (e.target.closest(".fg-node")) return;
    dragRef.current = { mode: "pan", sx: e.clientX, sy: e.clientY, bx: viewport.x, by: viewport.y };
  }, [viewport]);

  useEffect(() => {
    const onMove = e => {
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === "pan") {
        setViewport(v => ({ ...v, x: d.bx + (e.clientX - d.sx), y: d.by + (e.clientY - d.sy) }));
      }
      if (d.mode === "node") {
        const dx = (e.clientX - d.sx) / viewport.scale;
        const dy = (e.clientY - d.sy) / viewport.scale;
        setManualPos(p => ({ ...p, [d.nodeId]: { x: d.ox + dx, y: d.oy + dy } }));
        d.moved = true;
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d?.mode === "node" && !d.moved) {
        // Single click on node
        const node = graph?.nodeMap[d.nodeId];
        if (node?.type === "task") {
          setTaskModalId(node.id);
        } else if (node) {
          setFocusedId(node.id);
          setPanelOpen(true);
        }
      }
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [viewport.scale, graph]);

  // ── People options (only person nodes) ──
  const peopleOptions = useMemo(() =>
    graph ? graph.nodes.filter(n => n.type === "person").map(n => n.label).sort() : []
  , [graph]);

  const modalNode  = taskModalId ? graph?.nodeMap[taskModalId] : null;
  const panelNode  = focusState.focusNode;
  const threadData = panelNode?.type === "thread" ? threadCache[panelNode.metadata.conversationId] : null;

  const isLoading = loadingList || loadingDetail;

  return (
    <div className="fg-root">
      {/* ── Page header ── */}
      <div className="page-header">
        <div className="page-title">🎯 Focus Graph</div>
        <div className="page-subtitle">Click through your project context. Everything in one canvas.</div>
      </div>

      {listError && <div className="error-state">⚠ {listError}</div>}

      <div className="fg-shell">

        {/* ── Top bar ── */}
        <div className="fg-topbar card">
          {/* Project selector */}
          <select
            className="fg-select fg-select--primary"
            value={projectName}
            onChange={e => setProjectName(e.target.value)}
          >
            {(listData?.meta?.projectOptions || []).map(o => (
              <option key={o.id} value={o.name}>{o.name}</option>
            ))}
            {!listData?.meta?.projectOptions?.length && <option value="">Loading projects…</option>}
          </select>

          <div className="fg-topbar__divider" />

          {/* Person filter */}
          <select className="fg-select" value={filters.person} onChange={e => setFilters(f => ({ ...f, person: e.target.value }))}>
            <option value="">All people</option>
            {peopleOptions.map(p => <option key={p} value={p}>{p}</option>)}
          </select>

          {/* Source filter */}
          <select className="fg-select" value={filters.source} onChange={e => setFilters(f => ({ ...f, source: e.target.value }))}>
            <option value="all">All types</option>
            <option value="thread">Threads</option>
            <option value="meeting">Meetings</option>
            <option value="task">Tasks</option>
            <option value="person">People</option>
          </select>

          {/* Urgency filter */}
          <select className="fg-select" value={filters.urgency} onChange={e => setFilters(f => ({ ...f, urgency: e.target.value }))}>
            <option value="all">All urgency</option>
            <option value="critical">Overdue / Blocked</option>
            <option value="attention">Due Soon</option>
            <option value="watch">This Week</option>
            <option value="on_track">On Track</option>
            <option value="waiting">Waiting</option>
          </select>

          {/* Ownership filter */}
          <select className="fg-select" value={filters.ownership} onChange={e => setFilters(f => ({ ...f, ownership: e.target.value }))}>
            <option value="all">Mine + Delegated</option>
            <option value="mine">Mine only</option>
            <option value="delegated">Delegated / Waiting</option>
          </select>

          {/* Reset focus button */}
          {focusedId && focusedId !== graph?.projectId && (
            <button
              className="fg-btn fg-btn--ghost"
              onClick={() => { setFocusedId(graph?.projectId || ""); setManualPos({}); }}
            >
              ↩ Reset view
            </button>
          )}
        </div>

        {/* ── Canvas + Panel ── */}
        <div className={`fg-layout ${panelOpen ? "fg-layout--panel-open" : ""}`}>

          {/* Canvas */}
          <div
            ref={canvasRef}
            className="fg-canvas card"
            onMouseDown={handleCanvasDown}
            onWheel={handleWheel}
          >
            {isLoading && (
              <div className="loading-state" style={{ padding: 80 }}>
                <div className="spinner" />
                <div className="loading-text">Building project context graph…</div>
              </div>
            )}

            {!isLoading && !graph && (
              <div className="empty-state" style={{ padding: 80 }}>
                <div className="empty-icon">🎯</div>
                <div className="empty-text">Select a project to begin.</div>
              </div>
            )}

            {!isLoading && graph && (
              <div
                className="fg-scene"
                style={{
                  width:     SCENE.w,
                  height:    SCENE.h,
                  transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
                }}
              >
                {/* Edges */}
                <svg className="fg-edges" width={SCENE.w} height={SCENE.h}>
                  <defs>
                    <marker id="fg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M0,0 L10,5 L0,10 z" fill="rgba(148,163,184,0.6)" />
                    </marker>
                  </defs>
                  {focusState.visible && graph.edges.map(edge => {
                    const fpos = positions[edge.from];
                    const tpos = positions[edge.to];
                    if (!fpos || !tpos) return null;
                    if (!focusState.visible.has(edge.from) && !focusState.visible.has(edge.to)) return null;
                    const dimmed = !highlightSet.has(edge.from) || !highlightSet.has(edge.to);
                    return (
                      <line
                        key={edge.id}
                        x1={fpos.x} y1={fpos.y}
                        x2={tpos.x} y2={tpos.y}
                        className={`fg-edge ${dimmed ? "fg-edge--dimmed" : ""}`}
                        markerEnd="url(#fg-arrow)"
                      />
                    );
                  })}
                </svg>

                {/* Nodes */}
                {graph.nodes.map(node => {
                  const pos = positions[node.id];
                  if (!pos) return null;
                  const isVisible = focusState.visible.has(node.id);
                  const isDimmed  = !isVisible || !highlightSet.has(node.id);
                  const isActive  = focusState.focusNode?.id === node.id;
                  if (!isVisible && !focusedId) return null; // on initial load, only show visible
                  return (
                    <GraphNode
                      key={node.id}
                      node={node}
                      pos={pos}
                      isActive={isActive}
                      isDimmed={isDimmed}
                      onMouseDown={e => {
                        e.stopPropagation();
                        dragRef.current = {
                          mode: "node", nodeId: node.id, moved: false,
                          sx: e.clientX, sy: e.clientY,
                          ox: pos.x, oy: pos.y,
                        };
                      }}
                    />
                  );
                })}
              </div>
            )}

            {/* Legend */}
            <Legend />

            {/* Zoom controls */}
            <div className="fg-zoom-controls">
              <button onClick={() => setViewport(v => ({ ...v, scale: Math.min(2, v.scale + 0.12) }))}>+</button>
              <button onClick={() => setViewport(v => ({ ...v, scale: Math.max(0.35, v.scale - 0.12) }))}>−</button>
              <button onClick={() => { setViewport({ x: 0, y: 0, scale: 0.75 }); setManualPos({}); }}>⌂</button>
            </div>
          </div>

          {/* Side panel */}
          <aside className={`fg-panel card ${panelOpen ? "fg-panel--open" : "fg-panel--closed"}`}>
            <div className="fg-panel__bar">
              <button className="fg-panel__toggle" onClick={() => setPanelOpen(o => !o)}>
                {panelOpen ? "Hide →" : "← Details"}
              </button>
            </div>
            {panelOpen && (
              <div className="fg-panel__scroll">
                <SidePanel
                  node={panelNode}
                  graph={graph}
                  threadState={threadData}
                  onGoDeeper={onGoDeeper}
                  onCopyReply={r => navigator.clipboard.writeText(r)}
                />
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* Task modal */}
      <TaskModal node={modalNode} onClose={() => setTaskModalId("")} />
    </div>
  );
}