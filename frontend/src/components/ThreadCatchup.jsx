// src/components/ThreadCatchup.jsx
//
// api.js additions needed:
//   export const getProjectsSummary = (threads) =>
//     apiFetch("/projects-summary", { method: "POST", body: JSON.stringify({ threads }) });

import React, { useState, useCallback } from "react";
import { getInbox, getThreadCatchup, getProjectsSummary, getEvents } from "../services/api";
import { formatDistanceToNow, format } from "date-fns";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function relativeDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const diffHrs = diffMs / 36e5;
    if (diffHrs < 24) return format(d, "h:mm a");
    if (diffHrs < 168) return format(d, "EEE");
    return format(d, "MMM d");
  } catch {
    return "";
  }
}

function fullDate(iso) {
  if (!iso) return "";
  try {
    return format(new Date(iso), "EEE, MMM d 'at' h:mm a");
  } catch {
    return iso;
  }
}

function initialsAvatar(name = "") {
  const parts = name.trim().split(/\s+/);
  const initials = parts.length >= 2
    ? parts[0][0] + parts[parts.length - 1][0]
    : (name[0] || "?");
  return initials.toUpperCase();
}

// Deterministic hue from a string (for avatar colours)
function nameHue(name = "") {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return Math.abs(h) % 360;
}

const PRIORITY_META = {
  high:   { label: "High",   bg: "var(--red-light)",    color: "var(--red)",    dot: "#ef4444" },
  medium: { label: "Medium", bg: "var(--orange-light)",  color: "var(--orange)", dot: "#f97316" },
  low:    { label: "Low",    bg: "var(--green-light)",   color: "var(--green)",  dot: "#22c55e" },
};

// ─────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────

export default function ThreadCatchup() {
  const [inbox, setInbox]                   = useState([]);
  const [loadingInbox, setLoadingInbox]     = useState(false);
  const [selectedThread, setSelectedThread] = useState(null);
  const [threadMessages, setThreadMessages] = useState([]);
  const [catchup, setCatchup]               = useState(null);
  const [loadingCatchup, setLoadingCatchup] = useState(false);
  const [events, setEvents]                 = useState([]);
  const [projects, setProjects]             = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [expandedMsgs, setExpandedMsgs]     = useState(new Set());
  const [searchQuery, setSearchQuery]       = useState("");
  const [error, setError]                   = useState(null);

  // ── Load inbox + trigger project analysis ──
  const loadInbox = async () => {
    setLoadingInbox(true);
    setLoadingProjects(true);
    setError(null);
    setProjects([]);
    try {
      const [r, eventsResult] = await Promise.all([
        getInbox(30),
        getEvents().catch(() => ({ events: [] })),
      ]);
      const threads = r.messages || [];
      const upcomingEvents = (eventsResult.events || []).slice(0, 10).map((e) => ({
        id: e.id,
        subject: e.subject || "",
        start: e.start?.dateTime || e.start || null,
        attendees: (e.attendees || []).map((a) => a.emailAddress?.name || a.emailAddress?.address || "").filter(Boolean),
      }));
      setInbox(threads);
      setEvents(upcomingEvents);

      // Fire project analysis in parallel (non-blocking UI)
      if (threads.length > 0) {
        fetchProjects(threads, upcomingEvents);
      } else {
        setLoadingProjects(false);
      }
    } catch (e) {
      setError(e.message);
      setLoadingProjects(false);
    } finally {
      setLoadingInbox(false);
    }
  };

  const fetchProjects = useCallback(async (threads, upcomingEvents = []) => {
    try {
      const data = await getProjectsSummary(threads, upcomingEvents);
      setProjects(data.projects || []);
    } catch {
      // Projects panel is non-critical — fail silently
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  // ── Select a thread ──
  const handleSelectThread = useCallback(async (thread) => {
    if (!thread?.conversationId) return;
    setSelectedThread(thread);
    setCatchup(null);
    setThreadMessages([]);
    setExpandedMsgs(new Set());
    setLoadingCatchup(true);
    setError(null);
    try {
      const result = await getThreadCatchup(thread.conversationId);
      const msgs = result.messages || [];
      setCatchup(result.catchup);
      setThreadMessages(msgs);
      // Auto-expand the latest message
      if (msgs.length > 0) {
        setExpandedMsgs(new Set([msgs[msgs.length - 1].id]));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingCatchup(false);
    }
  }, []);

  // ── Select thread from project card ──
  const handleSelectProject = useCallback((project) => {
    const thread = inbox.find((t) => t.conversationId === project.threadId);
    if (thread) handleSelectThread(thread);
  }, [inbox, handleSelectThread]);

  const toggleMessage = (id) => {
    setExpandedMsgs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const filtered = inbox.filter(
    (t) =>
      !searchQuery ||
      t.subject?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.latestFrom?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (t.participantNames || []).some((n) => n.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Thread Catch-Up</div>
        <div className="page-subtitle">
          Your inbox, clustered by project — click any thread for a 3-line catch-up.
        </div>
      </div>

      {error && <div className="error-state">⚠️ {error}</div>}

      {/* ── Projects Panel ── */}
      {(loadingProjects || projects.length > 0) && (
        <ProjectsPanel
          projects={projects}
          loading={loadingProjects}
          onSelect={handleSelectProject}
          selectedThreadId={selectedThread?.conversationId}
        />
      )}

      {/* ── Main Grid ── */}
      <div className="content-grid">

        {/* Thread list */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="card-header" style={{ padding: "14px 16px" }}>
            <div className="card-title">Inbox</div>
            <button className="btn btn-ghost" onClick={loadInbox} disabled={loadingInbox}>
              {loadingInbox ? "Loading…" : inbox.length > 0 ? "Refresh" : "Load Inbox"}
            </button>
          </div>

          {inbox.length > 0 && (
            <div style={{ padding: "0 12px 10px" }}>
              <input
                type="text"
                placeholder="Search threads…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: "100%",
                  padding: "7px 11px",
                  borderRadius: 7,
                  border: "1px solid var(--border)",
                  fontSize: 13,
                  background: "var(--bg)",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          )}

          {loadingInbox ? (
            <div className="loading-state" style={{ padding: 40 }}>
              <div className="spinner" />
            </div>
          ) : filtered.length === 0 && inbox.length === 0 ? (
            <div className="empty-state" style={{ padding: "40px 20px" }}>
              <div className="empty-icon">📭</div>
              <div className="empty-text">Click "Load Inbox" to fetch your recent threads.</div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty-state" style={{ padding: 30 }}>
              <div className="empty-text">No threads match "{searchQuery}".</div>
            </div>
          ) : (
            <div style={{ maxHeight: 540, overflowY: "auto" }}>
              {filtered.map((thread) => (
                <ThreadRow
                  key={thread.conversationId}
                  thread={thread}
                  selected={selectedThread?.conversationId === thread.conversationId}
                  onClick={() => handleSelectThread(thread)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Thread detail + catchup */}
        <div className="card" style={{ overflow: "hidden", minWidth: 0, padding: 0 }}>
          {!selectedThread ? (
            <div className="empty-state" style={{ padding: 60 }}>
              <div className="empty-icon">📧</div>
              <div className="empty-text">Select a thread to read the catch-up.</div>
            </div>
          ) : loadingCatchup ? (
            <div className="loading-state" style={{ padding: 60 }}>
              <div className="spinner" />
              <div className="loading-text">Reading the thread…</div>
            </div>
          ) : (
            <div style={{ overflowY: "auto", maxHeight: "78vh" }}>
              {/* 3-line catchup at top */}
              {catchup && (
                <CatchupSummary catchup={catchup} />
              )}

              {/* Gmail-style message thread */}
              {threadMessages.length > 0 && (
                <MessageThread
                  messages={threadMessages}
                  expandedMsgs={expandedMsgs}
                  onToggle={toggleMessage}
                />
              )}

              {/* Suggested reply */}
              {catchup?.suggestedReply && (
                <SuggestedReply text={catchup.suggestedReply} />
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Projects Panel
// ─────────────────────────────────────────────

function ProjectsPanel({ projects, loading, onSelect, selectedThreadId }) {
  return (
    <div style={{ marginBottom: 20, padding: "0 28px" }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: "var(--text-tertiary)",
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        marginBottom: 10,
      }}>
        Active Projects
      </div>

      {loading ? (
        <div style={{ display: "flex", gap: 12 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{
              width: 260,
              height: 110,
              borderRadius: 10,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              animation: "pulse 1.5s infinite",
              flexShrink: 0,
            }} />
          ))}
        </div>
      ) : (
        <div style={{
          display: "flex",
          gap: 12,
          overflowX: "auto",
          paddingBottom: 4,
          scrollbarWidth: "none",
          justifyContent: projects.length <= 3 ? "center" : "flex-start",
        }}>
          {projects.map((project, i) => (
            <ProjectCard
              key={i}
              project={project}
              active={selectedThreadId === project.threadId}
              onClick={() => onSelect(project)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project, active, onClick }) {
  const pm = PRIORITY_META[project.priority] || PRIORITY_META.medium;

  return (
    <div
      onClick={onClick}
      style={{
        flexShrink: 0,
        width: 268,
        padding: "14px 16px",
        borderRadius: 12,
        border: `1.5px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "var(--accent-light)" : "var(--card)",
        cursor: "pointer",
        transition: "all 0.15s",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* Name + priority */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: "var(--text-primary)", lineHeight: 1.3 }}>
          {project.name}
        </div>
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          padding: "2px 7px",
          borderRadius: 10,
          background: pm.bg,
          color: pm.color,
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}>
          {pm.label}
        </span>
      </div>

      {/* Summary */}
      <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
        {project.summary}
      </div>

      {/* Next meeting */}
      {project.nextMeeting && (
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11,
          color: project.nextMeetingId ? "var(--accent)" : "var(--text-tertiary)",
          fontWeight: 600,
          background: project.nextMeetingId ? "var(--accent-light)" : "var(--bg)",
          padding: "3px 8px",
          borderRadius: 8,
          alignSelf: "flex-start",
          border: project.nextMeetingId ? "none" : "1px solid var(--border)",
        }}>
          📅 {project.nextMeeting}
        </div>
      )}

      {/* Key task */}
      <div style={{
        fontSize: 11,
        color: "var(--text-tertiary)",
        fontStyle: "italic",
        lineHeight: 1.4,
        borderTop: "1px solid var(--border)",
        paddingTop: 8,
      }}>
        ⚡ {project.keyTask}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Thread Row (inbox list item)
// ─────────────────────────────────────────────

function ThreadRow({ thread, selected, onClick }) {
  const hue = nameHue(thread.latestFrom?.name || thread.subject || "");
  const initials = initialsAvatar(thread.latestFrom?.name || thread.subject || "?");

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 11,
        padding: "11px 16px",
        borderBottom: "1px solid var(--border)",
        background: selected ? "var(--accent-light)" : "transparent",
        borderLeft: selected ? "3px solid var(--accent)" : "3px solid transparent",
        cursor: "pointer",
        transition: "background 0.12s",
      }}
    >
      {/* Avatar */}
      <div style={{
        width: 36,
        height: 36,
        borderRadius: "50%",
        background: `hsl(${hue}, 55%, 88%)`,
        color: `hsl(${hue}, 55%, 35%)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        fontWeight: 700,
        flexShrink: 0,
        marginTop: 1,
      }}>
        {initials}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
          <span style={{
            fontSize: 13,
            fontWeight: thread.isRead ? 500 : 700,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            marginRight: 8,
          }}>
            {thread.latestFrom?.name || thread.latestFrom?.address || "Unknown"}
            {thread.messageCount > 1 && (
              <span style={{
                marginLeft: 5,
                fontSize: 11,
                fontWeight: 400,
                color: "var(--text-tertiary)",
              }}>
                ({thread.messageCount})
              </span>
            )}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap", flexShrink: 0 }}>
            {relativeDate(thread.latestDate)}
          </span>
        </div>

        <div style={{
          fontSize: 13,
          fontWeight: thread.isRead ? 400 : 600,
          color: thread.isRead ? "var(--text-secondary)" : "var(--text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          marginBottom: 2,
        }}>
          {thread.subject || "(No subject)"}
        </div>

        <div style={{
          fontSize: 12,
          color: "var(--text-tertiary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {thread.bodyPreview || ""}
        </div>
      </div>

      {/* Unread dot */}
      {!thread.isRead && (
        <div style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "var(--accent)",
          flexShrink: 0,
          marginTop: 6,
        }} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 3-Line Catchup Summary (pinned at top of detail pane)
// ─────────────────────────────────────────────

const URGENCY_BORDER = {
  high:   "var(--red)",
  medium: "var(--orange)",
  low:    "var(--green)",
};

function CatchupSummary({ catchup }) {
  const borderColor = URGENCY_BORDER[catchup.urgency] || "var(--accent)";
  const pm = PRIORITY_META[catchup.urgency] || PRIORITY_META.medium;

  return (
    <div style={{
      margin: "0 0 0 0",
      padding: "16px 20px",
      borderBottom: "1px solid var(--border)",
      background: "var(--card)",
    }}>
      {/* Subject + priority badge */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-primary)", flex: 1 }}>
          {catchup.subject}
        </div>
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          padding: "3px 9px",
          borderRadius: 10,
          background: pm.bg,
          color: pm.color,
          whiteSpace: "nowrap",
          flexShrink: 0,
          textTransform: "capitalize",
        }}>
          {pm.label} priority
        </span>
      </div>

      {/* 3 lines */}
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        <CatchupLine
          label="What This Is About"
          color="var(--accent)"
          borderColor={borderColor}
          text={catchup.whatThisIsAbout}
        />
        <CatchupLine
          label="Where It Stands Now"
          color="var(--orange)"
          borderColor={borderColor}
          text={catchup.whereItStandsNow}
        />
        <CatchupLine
          label="What's Expected of You"
          color="var(--green)"
          borderColor={borderColor}
          text={catchup.whatIsExpectedOfYou}
          last
        />
      </div>
    </div>
  );
}

function CatchupLine({ label, color, text, last }) {
  return (
    <div style={{
      display: "flex",
      gap: 12,
      paddingTop: 10,
      paddingBottom: last ? 0 : 10,
      borderBottom: last ? "none" : "1px solid var(--border)",
    }}>
      <div style={{
        width: 3,
        borderRadius: 2,
        background: color,
        flexShrink: 0,
        minHeight: 20,
        alignSelf: "stretch",
      }} />
      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: 10,
          fontWeight: 700,
          color,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          marginBottom: 3,
        }}>
          {label}
        </div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          {text}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Gmail-style message thread
// ─────────────────────────────────────────────

function MessageThread({ messages, expandedMsgs, onToggle }) {
  return (
    <div style={{ padding: "12px 20px" }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: "var(--text-tertiary)",
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        marginBottom: 10,
      }}>
        Thread · {messages.length} {messages.length === 1 ? "message" : "messages"}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {messages.map((msg, idx) => {
          const isExpanded = expandedMsgs.has(msg.id);
          const isLatest = idx === messages.length - 1;
          return (
            <MessageBubble
              key={msg.id || idx}
              msg={msg}
              expanded={isExpanded}
              isLatest={isLatest}
              onToggle={() => onToggle(msg.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function MessageBubble({ msg, expanded, isLatest, onToggle }) {
  const hue = nameHue(msg.from?.name || "");
  const initials = initialsAvatar(msg.from?.name || "?");

  return (
    <div style={{
      border: "1px solid var(--border)",
      borderRadius: 10,
      overflow: "hidden",
      background: "var(--card)",
      boxShadow: isLatest ? "0 1px 4px rgba(0,0,0,0.06)" : "none",
    }}>
      {/* Header row — always visible, click to expand/collapse */}
      <div
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: expanded ? "12px 14px 8px" : "10px 14px",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        {/* Avatar */}
        <div style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: `hsl(${hue}, 55%, 88%)`,
          color: `hsl(${hue}, 55%, 35%)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 700,
          flexShrink: 0,
        }}>
          {initials}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-primary)" }}>
              {msg.from?.name || msg.from?.address || "Unknown"}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap", marginLeft: 8 }}>
              {fullDate(msg.receivedDateTime)}
            </span>
          </div>

          {!expanded && (
            <div style={{
              fontSize: 12,
              color: "var(--text-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              marginTop: 1,
            }}>
              {msg.bodyPreview || ""}
            </div>
          )}
        </div>

        {/* Expand/collapse chevron */}
        <div style={{
          fontSize: 12,
          color: "var(--text-tertiary)",
          transform: expanded ? "rotate(180deg)" : "none",
          transition: "transform 0.15s",
          flexShrink: 0,
          marginLeft: 4,
        }}>
          ▾
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={{ padding: "0 14px 14px 56px" }}>
          {/* To recipients */}
          {msg.to && msg.to.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 10 }}>
              To: {msg.to.map((r) => r.name || r.address).join(", ")}
            </div>
          )}
          {/* Body */}
          <div style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.7,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}>
            {msg.bodyText || msg.bodyPreview || "(No content)"}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Suggested Reply
// ─────────────────────────────────────────────

function SuggestedReply({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ padding: "0 20px 20px" }}>
      <div style={{
        borderTop: "1px solid var(--border)",
        paddingTop: 14,
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          color: "var(--text-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          marginBottom: 10,
        }}>
          ✍️ Suggested Reply
        </div>
        <div style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 9,
          padding: "12px 14px",
          fontSize: 13,
          lineHeight: 1.7,
          whiteSpace: "pre-wrap",
          color: "var(--text-secondary)",
          fontFamily: "inherit",
        }}>
          {text}
        </div>
        <button
          className="btn btn-primary"
          style={{ marginTop: 10, fontSize: 12 }}
          onClick={handleCopy}
        >
          {copied ? "✓ Copied" : "Copy Reply"}
        </button>
      </div>
    </div>
  );
}