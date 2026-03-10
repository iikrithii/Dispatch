// src/components/PreCallBrief.jsx
import React, { useEffect, useState } from "react";
import { getEvents, getPreMeetingBrief } from "../services/api";
import { formatDistanceToNow } from "date-fns";

// ─────────────────────────────────────────────
// Date / time helpers
// ─────────────────────────────────────────────

/**
 * Extracts a Date-parseable string from a Graph API start object.
 * Graph returns IST times WITHOUT a timezone offset suffix when the
 * Prefer header is set (e.g. "2026-03-08T09:30:00.0000000").
 * JavaScript treats bare strings with no offset as LOCAL time, which
 * is wrong in any non-IST locale. We append +05:30 so the Date object
 * always represents the correct IST moment regardless of where the
 * browser is running.
 */
function getDateString(start) {
  if (!start) return null;

  // normalize inputs: Graph sometimes sends a string or an object { dateTime, timeZone }
  let raw = null;
  let tzName = null;

  if (typeof start === "string") {
    raw = start;
  } else if (start && start.dateTime) {
    raw = start.dateTime;
    tzName = start.timeZone || null;
  }

  if (!raw) return null;

  // If the raw string already contains an explicit offset or 'Z' at the end, return it unchanged.
  // Examples: "2026-03-08T09:30:00+05:30", "2026-03-08T04:00:00Z", "2026-03-08T09:30:00-07:00"
  if (/[+-]\d{2}:\d{2}$/.test(raw) || raw.endsWith("Z")) {
    return raw;
  }

  // Map common Graph/Windows time zone names to offsets (extend if you need more).
  // Important: keep this small and explicit to avoid incorrect guesses.
  const TZ_MAP = {
    "India Standard Time": "+05:30",
    "Asia/Kolkata": "+05:30",
    "UTC": "Z",
    "Coordinated Universal Time": "Z",
    "Pacific Standard Time": "-08:00",
    "Pacific Daylight Time": "-07:00",
    "Eastern Standard Time": "-05:00",
    "Eastern Daylight Time": "-04:00",
    // add others you rely on...
  };

  // If we have a known timezone name, use it
  if (tzName && TZ_MAP[tzName]) {
    const mapped = TZ_MAP[tzName];
    // if mapped is 'Z', append 'Z' (UTC); otherwise append the +HH:MM/-HH:MM offset
    return mapped === "Z" ? raw + "Z" : raw + mapped;
  }

  // Heuristic fallback:
  // - If the raw string contains fractional seconds but no offset, Graph likely returned local IST
  // - If no tz info at all, default to IST (because your backend prefers IST)
  // This is conservative for your app (you can change default to 'Z' if you prefer UTC fallback).
  const assumeIST = "+05:30";
  return raw + assumeIST;
}
function safeFormatTime(start) {
  const s = getDateString(start);
  if (!s) return "TBD";
  try {
    return new Date(s).toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return "TBD";
  }
}

function safeFormatDate(start) {
  const s = getDateString(start);
  if (!s) return "";
  try {
    return new Date(s).toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function safeFormatFull(start) {
  const s = getDateString(start);
  if (!s) return "";
  try {
    return new Date(s).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return s;
  }
}

function safeDistance(start) {
  const s = getDateString(start);
  if (!s) return "";
  try {
    return formatDistanceToNow(new Date(s), { addSuffix: true });
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────

export default function PreCallBrief() {
  const [events, setEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [brief, setBrief] = useState(null);
  const [loadingBrief, setLoadingBrief] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    getEvents()
      .then((r) => setEvents(r.events || []))
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
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingBrief(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Pre-Call Brief</div>
        <div className="page-subtitle">
          Select a meeting to get an AI-powered briefing before you join.
        </div>
      </div>

      {error && <div className="error-state">⚠️ {error}</div>}

      <div className="content-grid">
        {/* ── Meeting List ── */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">Upcoming Meetings</div>
          </div>

          {loadingEvents ? (
            <div className="loading-state" style={{ padding: 30 }}>
              <div className="spinner" />
            </div>
          ) : events.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📅</div>
              <div className="empty-text">
                No upcoming meetings in the next 7 days.
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {events.map((event) => (
                <div
                  key={event.id}
                  className="meeting-item"
                  style={{
                    background:
                      selectedEvent?.id === event.id
                        ? "var(--accent-light)"
                        : undefined,
                    borderColor:
                      selectedEvent?.id === event.id
                        ? "var(--accent)"
                        : undefined,
                  }}
                  onClick={() => handleSelectEvent(event)}
                >
                  <div className="meeting-time-block">
                    <div className="meeting-time">
                      {safeFormatTime(event.start)}
                    </div>
                    <div className="meeting-duration">
                      {safeFormatDate(event.start)}
                    </div>
                  </div>
                  <div className="meeting-info">
                    <div className="meeting-title">{event.subject}</div>
                    <div className="meeting-meta">
                      {event.attendees?.length || 0} attendees ·{" "}
                      {safeDistance(event.start)}
                      {event.isOnline && (
                        <span
                          style={{
                            marginLeft: 6,
                            background: "var(--green-light)",
                            color: "var(--green)",
                            padding: "1px 6px",
                            borderRadius: 10,
                            fontSize: 10,
                            fontWeight: 600,
                          }}
                        >
                          Online
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: 12, padding: "6px 12px" }}
                  >
                    Brief →
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Brief Panel ── */}
        <div className="card" style={{ overflow: "hidden", minWidth: 0 }}>
          {!selectedEvent ? (
            <div className="empty-state" style={{ padding: 60 }}>
              <div className="empty-icon">👈</div>
              <div className="empty-text">
                Select a meeting to generate your brief.
              </div>
            </div>
          ) : loadingBrief ? (
            <div className="loading-state">
              <div className="spinner" />
              <div className="loading-text">
                Analysing emails, past meetings, and documents…
              </div>
            </div>
          ) : brief ? (
            <BriefDisplay brief={brief.brief} event={brief.event} meta={brief.meta} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Brief display
// ─────────────────────────────────────────────

function BriefDisplay({ brief, event, meta }) {
  const joinUrl = event?.joinUrl || event?.onlineMeeting?.joinUrl;

  return (
    <div
      style={{
        overflowY: "auto",
        overflowX: "hidden",
        maxHeight: "78vh",
        paddingRight: 6,
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          marginBottom: 16,
          paddingBottom: 14,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            marginBottom: 4,
            wordBreak: "break-word",
            overflowWrap: "anywhere",
          }}
        >
          {brief?.meetingTitle || event?.subject}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          {/* IST time — safeFormatFull now appends +05:30 before parsing */}
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {safeFormatFull(event?.start)}
          </span>
          {joinUrl && (
            <a
              href={joinUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                fontSize: 12,
                color: "white",
                fontWeight: 600,
                background: "var(--accent)",
                padding: "3px 10px",
                borderRadius: 12,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              Join →
            </a>
          )}
        </div>

        <div
          style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6 }}
        >
          Based on {meta?.emailsAnalyzed || 0} emails
          {meta?.previousMeetingsFound > 0 &&
            ` · ${meta.previousMeetingsFound} past meeting(s) checked`}
        </div>
      </div>

      {/* ── Current Status ── */}
      {brief?.currentStatus && (
        <BriefSection icon="📊" title="Current Status">
          <p
            style={{
              margin: 0,
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.6,
              wordBreak: "break-word",
              overflowWrap: "anywhere",
            }}
          >
            {brief.currentStatus}
          </p>
        </BriefSection>
      )}

      {/* ── Follow-ups from Last Meeting ── */}
      {brief?.followUps && (
        <BriefSection
          icon="🔁"
          title="Follow-ups from Last Meeting"
          subtitle={`${brief.followUps.subject || ""}${brief.followUps.date ? " · " + brief.followUps.date : ""}`}
        >
          {/* Narrative — prose story of what happened in + after the meeting */}
          {brief.followUps.narrative && (
            <div
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.65,
                marginBottom: 14,
                padding: "10px 12px",
                background: "var(--bg)",
                borderRadius: 8,
                border: "1px solid var(--border)",
                wordBreak: "break-word",
                overflowWrap: "anywhere",
              }}
            >
              {brief.followUps.narrative}
            </div>
          )}

          {/* Action items */}
          {(brief.followUps.items || []).map((a, i) => (
            <ActionItem key={i} item={a} />
          ))}

          {/* Things planned for this / next meeting */}
          {(brief.followUps.nextMeetingPoints || []).length > 0 && (
            <div style={{ marginTop: 12 }}>
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
                Planned for this meeting
              </div>
              {brief.followUps.nextMeetingPoints.map((pt, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "3px 0",
                    fontSize: 13,
                    wordBreak: "break-word",
                    overflowWrap: "anywhere",
                  }}
                >
                  <span style={{ color: "var(--accent)", flexShrink: 0 }}>
                    →
                  </span>
                  <span>{pt}</span>
                </div>
              ))}
            </div>
          )}
        </BriefSection>
      )}

      {/* ── Open Points ── */}
      {(brief?.openPoints || []).length > 0 && (
        <BriefSection icon="⚠️" title="Open Points">
          {brief.openPoints.map((p, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 8,
                padding: "4px 0",
                fontSize: 13,
                wordBreak: "break-word",
                overflowWrap: "anywhere",
              }}
            >
              <span style={{ color: "var(--orange)", flexShrink: 0 }}>•</span>
              <span>{p}</span>
            </div>
          ))}
        </BriefSection>
      )}

      {/* ── Agenda for Today ── */}
      {(brief?.agendaForToday || []).length > 0 && (
        <BriefSection icon="🎯" title="Agenda for Today">
          {brief.agendaForToday.map((item, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 8,
                padding: "5px 0",
                fontSize: 13,
                wordBreak: "break-word",
                overflowWrap: "anywhere",
              }}
            >
              <span
                style={{
                  fontWeight: 700,
                  color: "var(--accent)",
                  minWidth: 18,
                  flexShrink: 0,
                }}
              >
                {i + 1}.
              </span>
              <span>{item}</span>
            </div>
          ))}
        </BriefSection>
      )}

      {/* ── Key Context ── */}
      {brief?.keyContext && (
        <BriefSection icon="💡" title="Key Context">
          <div
            style={{
              fontSize: 13,
              background: "var(--accent-light)",
              padding: 10,
              borderRadius: 8,
              borderLeft: "3px solid var(--accent)",
              wordBreak: "break-word",
              overflowWrap: "anywhere",
              lineHeight: 1.6,
            }}
          >
            {brief.keyContext}
          </div>
        </BriefSection>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────

function BriefSection({ icon, title, subtitle, children }) {
  return (
    <div className="brief-section">
      <div className="brief-section-title" style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 4 }}>
        <span>
          {icon} {title}
        </span>
        {subtitle && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 400,
              color: "var(--text-tertiary)",
              wordBreak: "break-word",
            }}
          >
            {subtitle}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function ActionItem({ item }) {
  const done = item.status === "done";
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "8px 10px",
        marginBottom: 6,
        borderRadius: 8,
        background: done ? "#f0fdf4" : "#fff7ed",
        borderLeft: `3px solid ${done ? "#16a34a" : "#ea580c"}`,
        boxSizing: "border-box",
        width: "100%",
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 14, marginTop: 1, flexShrink: 0 }}>
        {done ? "✅" : "⏳"}
      </span>

      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div
          style={{
            fontSize: 13,
            wordBreak: "break-word",
            overflowWrap: "anywhere",
          }}
        >
          <span style={{ fontWeight: 600, color: "var(--accent)" }}>
            {item.owner}
          </span>
          <span style={{ color: "var(--text-secondary)" }}>
            {" "}
            — {item.task}
          </span>
        </div>

        {item.evidence && (
          <div
            style={{
              fontSize: 11,
              color: "var(--text-tertiary)",
              marginTop: 3,
              fontStyle: "italic",
              wordBreak: "break-word",
            }}
          >
            {item.evidence}
          </div>
        )}

        {done && item.emailId && (
          <a
            href={`https://outlook.live.com/mail/0/inbox/${item.emailId}`}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 11,
              color: "var(--accent)",
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-block",
              marginTop: 4,
              wordBreak: "break-word",
            }}
          >
            📧 {item.emailSubject || "View confirmation"} →
          </a>
        )}
      </div>

      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          padding: "2px 7px",
          borderRadius: 10,
          background: done ? "#16a34a" : "#ea580c",
          color: "white",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {done ? "DONE" : "PENDING"}
      </span>
    </div>
  );
} 