// src/components/PreCallBrief.jsx
import React, { useEffect, useState } from "react";
import { getEvents, getPreMeetingBrief } from "../services/api";
import { formatDistanceToNow } from "date-fns";
import MeetingNotes from "./MeetingNotes";

// ─────────────────────────────────────────────
// Date / time helpers
// ─────────────────────────────────────────────

function getDateString(start) {
  if (!start) return null;
  let raw = null; let tzName = null;
  if (typeof start === "string") { raw = start; }
  else if (start?.dateTime)       { raw = start.dateTime; tzName = start.timeZone || null; }
  if (!raw) return null;
  if (/[+-]\d{2}:\d{2}$/.test(raw) || raw.endsWith("Z")) return raw;
  const TZ_MAP = {
    "India Standard Time": "+05:30", "Asia/Kolkata": "+05:30",
    "UTC": "Z", "Coordinated Universal Time": "Z",
    "Pacific Standard Time": "-08:00", "Pacific Daylight Time": "-07:00",
    "Eastern Standard Time": "-05:00", "Eastern Daylight Time": "-04:00",
  };
  if (tzName && TZ_MAP[tzName]) {
    const mapped = TZ_MAP[tzName];
    return mapped === "Z" ? raw + "Z" : raw + mapped;
  }
  return raw + "+05:30";
}

function safeFormatTime(start) {
  const s = getDateString(start); if (!s) return "TBD";
  try { return new Date(s).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }); }
  catch { return "TBD"; }
}

function safeFormatDate(start) {
  const s = getDateString(start); if (!s) return "";
  try { return new Date(s).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "short", day: "numeric" }); }
  catch { return ""; }
}

function safeFormatFull(start) {
  const s = getDateString(start); if (!s) return "";
  try { return new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }); }
  catch { return s; }
}

function safeDistance(start) {
  const s = getDateString(start); if (!s) return "";
  try { return formatDistanceToNow(new Date(s), { addSuffix: true }); }
  catch { return ""; }
}

function safeFormatShort(dateValue) {
  if (!dateValue) return null;
  try { return new Date(dateValue).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
  catch { return null; }
}

// ─────────────────────────────────────────────
// BriefSection
// ─────────────────────────────────────────────

function BriefSection({ icon, title, subtitle, children, defaultOpen = true, noToggle = false }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      {noToggle ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 12 }}>
          {icon && <span>{icon}</span>}
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{title}</span>
          {subtitle && <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-tertiary)" }}>{subtitle}</span>}
        </div>
      ) : (
        <button
          onClick={() => setOpen((o) => !o)}
          style={{
            display: "flex", alignItems: "center", gap: 6, width: "100%",
            background: "none", border: "none", padding: "0 0 10px 0", cursor: "pointer",
          }}
        >
          {icon && <span>{icon}</span>}
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", flex: 1, textAlign: "left" }}>
            {title}
            {subtitle && (
              <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-tertiary)", marginLeft: 6 }}>
                {subtitle}
              </span>
            )}
          </span>
          <span style={{
            fontSize: 20, color: "var(--text-tertiary)",
            display: "inline-block", transition: "transform 0.2s",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}>▾</span>
        </button>
      )}
      {(noToggle || open) && <div>{children}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────

export default function PreCallBrief() {
  const [events,         setEvents]        = useState([]);
  const [loadingEvents,  setLoadingEvents] = useState(true);
  const [selectedEvent,  setSelectedEvent] = useState(null);
  const [brief,          setBrief]         = useState(null);
  const [loadingBrief,   setLoadingBrief]  = useState(false);
  const [error,          setError]         = useState(null);
  const [notesMode,      setNotesMode]     = useState(null);

  useEffect(() => {
    getEvents()
    .then((r) => {
      const now = new Date();
      const upcoming = (r.events || []).filter(e => {
        const start = getDateString(e.start);
        return start && new Date(start) > now;
      });
      setEvents(upcoming);
    })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingEvents(false));
  }, []);

  const handleSelectEvent = async (event) => {
    setSelectedEvent(event);
    setBrief(null);
    setLoadingBrief(true);
    setError(null);
    try {
      const result = await getPreMeetingBrief(event.id);
      setBrief(result);
    } catch (e) { setError(e.message); }
    finally { setLoadingBrief(false); }
  };

  const handleAgendaUpdate = (updatedAgenda) => {
    setBrief((prev) =>
      prev ? { ...prev, brief: { ...prev.brief, agenda: updatedAgenda, agendaForToday: updatedAgenda } } : prev
    );
  };

  if (notesMode) {
    return (
      <MeetingNotes
        event={notesMode.event}
        brief={notesMode.brief}
        onBack={() => setNotesMode(null)}
      />
    );
  }

  const jiraData = brief?.brief;

  return (
    // Outer wrapper: 
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>

      <div className="page-header">
        <div className="page-title">Pre-Call Brief</div>
        <div className="page-subtitle">Select a meeting to get an AI-powered briefing before you join.</div>
      </div>

      {error && <div className="error-state">⚠️ {error}</div>}

      {/* content-grid fills all remaining vertical space */}
      <div className="content-grid" style={{ alignItems: "stretch", flex: 1, minHeight: 0 }}>

        {/* ════════════════════
            LEFT column
        ════════════════════ */}
        <div style={{ display: "flex", flexDirection: "column", gap: 15, minWidth: 0, height: "100%", minHeight: 0 }}>

          {/* Meeting list */}
          <div className="card" style={{ flexShrink: 0 }}>
            <div className="card-header">
              <div className="card-title">Upcoming Meetings</div>
            </div>

            {loadingEvents ? (
              <div className="loading-state" style={{ padding: 30 }}><div className="spinner" /></div>
            ) : events.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📅</div>
                <div className="empty-text">No upcoming meetings in the next 7 days.</div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 168, overflowY: "auto", paddingRight: 4 }}>
                {events.map((event) => (
                  <div
                    key={event.id}
                    className="meeting-item"
                    style={{
                      background:  selectedEvent?.id === event.id ? "var(--accent-light)" : undefined,
                      borderColor: selectedEvent?.id === event.id ? "var(--accent)"       : undefined,
                      cursor: "pointer",
                    }}
                    onClick={() => handleSelectEvent(event)}
                  >
                    <div className="meeting-time-block">
                      <div className="meeting-time">{safeFormatTime(event.start)}</div>
                      <div className="meeting-duration">{safeFormatDate(event.start)}</div>
                    </div>

                    <div className="meeting-info">
                      <div className="meeting-title">{event.subject}</div>
                      <div className="meeting-meta">
                        {event.attendees?.length || 0} attendees · {safeDistance(event.start)}
                        {event.isOnline && (
                          <span style={{ marginLeft: 6, background: "var(--green-light)", color: "var(--green)", padding: "1px 6px", borderRadius: 10, fontSize: 10, fontWeight: 600 }}>
                            Online
                          </span>
                        )}
                      </div>
                    </div>

                    {/* <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                      <button
                        className="btn btn-primary"
                        style={{ fontSize: 13, padding: "8px 16px", fontWeight: 600, borderRadius: 8 }}
                        onClick={(e) => { e.stopPropagation(); handleSelectEvent(event); }}
                      >
                        📋 Brief
                      </button>
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 13, padding: "8px 16px", fontWeight: 600, borderRadius: 8, border: "1px solid var(--border)", whiteSpace: "nowrap" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          const existingBrief = selectedEvent?.id === event.id && brief ? brief : null;
                          setNotesMode({ event, brief: existingBrief });
                        }}
                      >
                        📝 Notes
                      </button>
                    </div> */}

                    
                  </div>
                ))}

                
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
  {/* <button
    className="btn btn-primary"
    style={{ flex: 1, fontSize: 13, padding: "8px 0", fontWeight: 600, borderRadius: 8, opacity: selectedEvent ? 1 : 0.4, cursor: selectedEvent ? "pointer" : "default" }}
    disabled={!selectedEvent}
    onClick={() => selectedEvent && handleSelectEvent(selectedEvent)}
  >
    📋 Brief
  </button> */}
  <button
    className="btn btn-primary"
    style={{ flex: 1, justifyContent: "center", fontSize: 13, padding: "8px 0", fontWeight: 600, borderRadius: 8, border: "1px solid var(--border)", opacity: selectedEvent ? 1 : 0.4, cursor: selectedEvent ? "pointer" : "default" }}
    disabled={!selectedEvent}
    onClick={() => selectedEvent && setNotesMode({ event: selectedEvent, brief: brief || null })}
  >
    📝 Prepare Speaking Brief
  </button>
</div>
          </div>
{(
  jiraData?.executionContext ||
  (jiraData?.assignedToMe || []).length > 0 ||
  jiraData?.preMeetingChecks
) && (
  <div className="card" style={{ minWidth: 0, flex: 1, minHeight: 0, overflow: "auto" }}>
    <div style={{ marginBottom: 16 }}>
      <div className="card-title">Jira</div>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
        Execution context for this meeting
      </div>
    </div>

    {jiraData?.executionContext && (
      <BriefSection
        icon="🧩"
        title={jiraData.executionContext.title || "Jira Overview"}
        subtitle={jiraData.executionContext.spaceName ? `Space: ${jiraData.executionContext.spaceName}` : undefined}
        defaultOpen={true}
      >
        {jiraData.executionContext.statusLine && (
          <div
            style={{
              marginBottom: 12,
              padding: "10px 12px",
              background: "var(--bg)",
              borderRadius: 8,
              border: "1px solid var(--border)",
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.6,
            }}
          >
            {jiraData.executionContext.statusLine}
          </div>
        )}

        {(jiraData.executionContext.blockers || []).length > 0 && (
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "var(--text-tertiary)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 6,
              }}
            >
              What's Blocking the Team?
            </div>
            {jiraData.executionContext.blockers.map((item, i) => (
              <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 13 }}>
                <span style={{ color: "var(--red, #dc2626)", flexShrink: 0 }}>•</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
        )}
      </BriefSection>
    )}

    {(jiraData?.assignedToMe || []).length > 0 && (
      <BriefSection icon="📌" title="My Open Jira Items" defaultOpen={false}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {jiraData.assignedToMe.map((issue) => (
            <IssueCard key={issue.key} issue={issue} />
          ))}
        </div>
      </BriefSection>
    )}

    <BriefSection icon="👀" title="Before You Join" defaultOpen={false}>
      {(jiraData?.preMeetingChecks || []).length > 0 ? (
        jiraData.preMeetingChecks.map((item, i) => <PrepItem key={i} item={item} />)
      ) : (
        <div style={{ fontSize: 13, color: "var(--text-tertiary)", padding: "4px 0" }}>
          No pre-join checks found.
        </div>
      )}
    </BriefSection>
  </div>
)}

        </div>{/* end left column */}

        {/* ════════════════════
            RIGHT column 
        ════════════════════ */}
        <div className="card" style={{ overflow: "hidden", minWidth: 0, display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {!selectedEvent ? (
            <div className="empty-state" style={{ padding: 60 }}>
              <div className="empty-icon">👈</div>
              <div className="empty-text">Select a meeting to generate your brief.</div>
            </div>
          ) : loadingBrief ? (
            <div className="loading-state">
              <div className="spinner" />
              <div className="loading-text">Analysing emails, past meetings, and documents…</div>
            </div>
          ) : brief ? (
            <BriefDisplay
              brief={brief.brief}
              event={brief.event}
              meta={brief.meta}
              onAgendaUpdate={handleAgendaUpdate}
            />
          ) : null}
        </div>

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// BriefDisplay
// ─────────────────────────────────────────────

function BriefDisplay({ brief, event, meta, onAgendaUpdate }) {
  const joinUrl = event?.joinUrl || event?.onlineMeeting?.joinUrl;

  const evidenceItems = [
    { label: "Emails",        value: meta?.emailsAnalyzed        || 0 },
    { label: "Past Meetings", value: meta?.previousMeetingsFound || 0 },
    { label: "Jira Issues",   value: meta?.enabled ? (meta?.matchedIssueCount || 0) : 0 },
  ];

  return (
    <div style={{ overflowY: "auto", overflowX: "hidden", flex: 1, minHeight: 0, paddingRight: 4, width: "100%", boxSizing: "border-box" }}>

      <div style={{ paddingBottom: 16, marginBottom: 4, borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6, wordBreak: "break-word", overflowWrap: "anywhere" }}>
          {brief?.meetingTitle || event?.subject}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{safeFormatFull(event?.start)}</span>
          {joinUrl && (
            <a href={joinUrl} target="_blank" rel="noreferrer"
              style={{ fontSize: 12, color: "white", fontWeight: 600, background: "var(--accent)", padding: "4px 12px", borderRadius: 12, textDecoration: "none", whiteSpace: "nowrap" }}>
              Join →
            </a>
          )}
        </div>
      </div>

      <BriefSection icon="🛡️" title="How This Brief Was Prepared" noToggle>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {evidenceItems.map((item) => (
            <div key={item.label} style={{ padding: "12px 14px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)" }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--accent)", lineHeight: 1.1, marginBottom: 4 }}>{item.value}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{item.label}</div>
            </div>
          ))}
        </div>
      </BriefSection>

      {brief?.keyContext && (
        <BriefSection icon="💡" title="Key Context" noToggle>
          <div style={{ fontSize: 13, background: "var(--accent-light)", padding: "10px 12px", borderRadius: 8, borderLeft: "3px solid var(--accent)", wordBreak: "break-word", overflowWrap: "anywhere", lineHeight: 1.6 }}>
            {brief.keyContext}
          </div>
        </BriefSection>
      )}

      {brief?.currentStatus && (
        <BriefSection icon="📊" title="Current Status" noToggle>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, wordBreak: "break-word", overflowWrap: "anywhere" }}>
            {brief.currentStatus}
          </p>
        </BriefSection>
      )}

      {(brief?.agenda || brief?.agendaForToday || []).length > 0 && (
        <BriefSection icon="🎯" title="Agenda Today" defaultOpen>
          <AgendaList
            items={brief.agenda || brief.agendaForToday}
            onUpdate={onAgendaUpdate}
          />
        </BriefSection>
      )}

      {brief?.followUps && (
        <BriefSection
          icon="🔁"
          title="Last Meeting Follow-ups"
          subtitle={`${
            brief.followUps.subject || ""
          }${
            brief.followUps.date
              ? " · " +
                new Date(brief.followUps.date).toLocaleString("en-IN", {
                  day: "numeric",
                  month: "short",
                  
                })
              : ""
          }`}          defaultOpen
        >
          {brief.followUps.narrative && (
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.65, marginBottom: 12, padding: "10px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)", wordBreak: "break-word", overflowWrap: "anywhere" }}>
              {brief.followUps.narrative}
            </div>
          )}
          {(brief.followUps.items || []).length > 0 && (
            <ActionItemsDropdown items={brief.followUps.items} />
          )}
        </BriefSection>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────
// AgendaList
// ─────────────────────────────────────────────

function AgendaList({ items, onUpdate }) {
  const [localItems, setLocalItems] = useState(items);

  useEffect(() => { setLocalItems(items); }, [items]);

  const handleDelete = (index) => {
    const updated = localItems.filter((_, i) => i !== index);
    setLocalItems(updated);
    onUpdate && onUpdate(updated);
  };

  if (localItems.length === 0) {
    return (
      <div style={{ fontSize: 13, color: "var(--text-tertiary)", padding: "10px 0" }}>
        All agenda items removed.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {localItems.map((item, i) => (
        <AgendaItem key={i} item={item} onDelete={() => handleDelete(i)} />
      ))}
    </div>
  );
}

function AgendaItem({ item, onDelete }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const issues = item.issues || (item.issue ? [item.issue] : []);

  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
        <span style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }}>→</span>
        <span style={{ flex: 1, wordBreak: "break-word", overflowWrap: "anywhere", lineHeight: 1.5 }}>{item.text}</span>
        <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center", marginLeft: 8 }}>
          {issues.length > 0 && (
            <button
              onClick={() => setDetailsOpen((o) => !o)}
              style={{
                background: detailsOpen ? "var(--accent-light)" : "none",
                border: "1px solid var(--border)", borderRadius: 6,
                cursor: "pointer", fontSize: 11, color: "var(--text-secondary)",
                padding: "3px 9px", fontWeight: 600, whiteSpace: "nowrap",
              }}
            >
              {detailsOpen ? "Hide ▴" : "Details ▾"}
            </button>
          )}
          <button
            onClick={onDelete}
            title="Remove from agenda"
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--text-tertiary)", fontSize: 16, lineHeight: 1,
              padding: "2px 4px", borderRadius: 4,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--red, #dc2626)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-tertiary)")}
          >
            ✕
          </button>
        </div>
      </div>
      {detailsOpen && issues.length > 0 && (
        <div style={{ marginTop: 10, marginLeft: 18, display: "grid", gap: 8 }}>
          {issues.map((issue) => <IssueCard key={issue.key} issue={issue} compact />)}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// ActionItemsDropdown
// ─────────────────────────────────────────────

function ActionItemsDropdown({ items }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between",
          width: "100%", background: open ? "var(--accent-light)" : "var(--bg)",
          border: "1px solid var(--border)", borderRadius: 8,
          cursor: "pointer", fontSize: 12, color: "var(--text-secondary)",
          padding: "8px 14px", fontWeight: 600,
        }}
      >
        <span>📋 View {items.length} action item{items.length !== 1 ? "s" : ""}</span>
        <span style={{ display: "inline-block", transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}>▾</span>
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {items.map((a, i) => <ActionItem key={i} item={a} />)}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────

function ActionItem({ item }) {
  const done = item.status === "done";
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", marginBottom: 6, borderRadius: 8, background: done ? "#f0fdf4" : "#fff7ed", borderLeft: `3px solid ${done ? "#16a34a" : "#ea580c"}`, boxSizing: "border-box", width: "100%", minWidth: 0 }}>
      <span style={{ fontSize: 14, marginTop: 1, flexShrink: 0 }}>{done ? "✅" : "⏳"}</span>
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{ fontSize: 13, wordBreak: "break-word", overflowWrap: "anywhere" }}>
          <span style={{ fontWeight: 600, color: "var(--accent)" }}>{item.owner}</span>
          <span style={{ color: "var(--text-secondary)" }}> — {item.task}</span>
        </div>
        {item.evidence && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 3, fontStyle: "italic", wordBreak: "break-word" }}>{item.evidence}</div>}
        {done && item.emailId && (
          <a href={`https://outlook.live.com/mail/0/inbox/${item.emailId}`} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, textDecoration: "none", display: "inline-block", marginTop: 4 }}>
            📧 {item.emailSubject || "View confirmation"} →
          </a>
        )}
      </div>
      <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: done ? "#16a34a" : "#ea580c", color: "white", whiteSpace: "nowrap", flexShrink: 0 }}>
        {done ? "DONE" : "PENDING"}
      </span>
    </div>
  );
}

function PrepItem({ item }) {
  const issues = item.issues || (item.issue ? [item.issue] : []);
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 8, paddingBottom: issues.length ? 8 : 0, fontSize: 13, wordBreak: "break-word", overflowWrap: "anywhere", lineHeight: 1.5 }}>
        <span style={{ color: "var(--accent)", flexShrink: 0 }}>→</span>
        <span>{item.text}</span>
      </div>
      {issues.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginLeft: 16 }}>
          {issues.map((issue) => <IssueCard key={issue.key} issue={issue} compact />)}
        </div>
      )}
    </div>
  );
}

function IssueCard({ issue, compact = false }) {
  const dueDate   = safeFormatShort(issue.dueDate);
  const updatedAt = safeFormatShort(issue.updatedAt);
  const isDone    = /^(done|closed|resolved)$/i.test(issue.status || "");
  const statusColor = issue.isBlocked ? "var(--red, #dc2626)" : isDone ? "var(--green)" : "var(--accent)";
  const statusBg    = issue.isBlocked ? "var(--red-light, #fee2e2)" : isDone ? "var(--green-light)" : "var(--accent-light)";

  const card = (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--surface, var(--bg))" }}>
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 700, marginBottom: 3 }}>{issue.key}</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", wordBreak: "break-word" }}>{issue.title}</div>
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 999, whiteSpace: "nowrap", color: statusColor, background: statusBg }}>
          {issue.status}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 11, color: "var(--text-secondary)" }}>
        <span>{issue.assignee || "Unassigned"}</span>
        <span>•</span><span>{issue.priority || "No priority"}</span>
        {dueDate   && <><span>•</span><span>Due {dueDate}</span></>}
        {updatedAt && <><span>•</span><span>Updated {updatedAt}</span></>}
        {issue.isBlocked && <><span>•</span><span style={{ color: "var(--red, #dc2626)", fontWeight: 600 }}>Blocked</span></>}
      </div>
    </div>
  );

  if (!issue.url) return card;
  return (
    <a href={issue.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      {card}
    </a>
  );
}