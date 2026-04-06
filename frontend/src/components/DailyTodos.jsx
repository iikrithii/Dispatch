// src/components/DailyTodos.jsx
import React, { useEffect, useState } from "react";
import { getDailyTodos } from "../services/api";
import { format } from "date-fns";

const TYPE_ICONS = {
  meeting: "📅",
  task: "✅",
  email: "📧",
  deadline: "⏰",
};

const URGENCY_CLASS = {
  high: "badge-high",
  medium: "badge-medium",
  low: "badge-low",
};

export default function DailyTodos() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getDailyTodos()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div className="loading-state">
        <div className="spinner" />
        <div className="loading-text">Building your day…</div>
      </div>
    );

  if (error)
    return (
      <div className="error-state">
        ⚠️ {error}
      </div>
    );

  const { priorities, rawData, meta } = data || {};

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          {format(new Date(), "EEEE, MMMM d")}
        </div>
        <div className="page-subtitle">
          {priorities?.greeting || "Here's your day at a glance."}
        </div>
      </div>

      {/* Stats row */}
      <div style={{ padding: "0 28px", display: "flex", gap: 12, marginBottom: 20 }}>
        {[
          { label: "Meetings", value: meta?.meetingCount || 0, icon: "📅" },
          { label: "Tasks", value: meta?.taskCount || 0, icon: "✅" },
          { label: "Pending approvals", value: rawData?.pendingApprovalCount || 0, icon: "⏳" },
          { label: "Due reminders", value: rawData?.dueReminders?.length || 0, icon: "🔔" },
        ].map((stat) => (
          <div key={stat.label} className="card" style={{ flex: 1, textAlign: "center" }}>
            <div style={{ fontSize: 24 }}>{stat.icon}</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{stat.value}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{stat.label}</div>
          </div>
        ))}
      </div>

      <div className="content-grid">
        {/* Top Priorities */}
        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <div className="card-header">
            <div className="card-title">Today's Priorities</div>
            <span className="badge badge-accent">AI-ranked</span>
          </div>

          {(priorities?.topPriorities || []).length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🎉</div>
              <div className="empty-text">Nothing urgent. You're ahead of the game.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(priorities?.topPriorities || []).map((item, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                    padding: "12px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: i === 0 ? "var(--accent-light)" : "transparent",
                  }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: i === 0 ? "var(--accent)" : "var(--border)",
                      color: i === 0 ? "white" : "var(--text-secondary)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 13,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {i + 1}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span>{TYPE_ICONS[item.type] || "•"}</span>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{item.title}</span>
                      {item.time && (
                        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                          {item.time}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                      {item.context}
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--accent)",
                      textTransform: "uppercase",
                      background: "var(--accent-light)",
                      padding: "3px 8px",
                      borderRadius: 20,
                      flexShrink: 0,
                    }}
                  >
                    {item.action}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Today's Meetings */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">Today's Meetings</div>
          </div>
          {(rawData?.meetings || []).length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🏖️</div>
              <div className="empty-text">No meetings today.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(rawData?.meetings || []).map((m) => (
                <div key={m.id} className="meeting-item">
                  <div className="meeting-time-block">
                    <div className="meeting-time">
                      {m.start
                        ? format(new Date(m.start), "HH:mm")
                        : "TBD"}
                    </div>
                  </div>
                  <div className="meeting-info">
                    <div className="meeting-title">{m.subject}</div>
                    <div className="meeting-meta">
                      {m.attendeeCount} attendees
                      {m.joinUrl && (
                        <a
                          href={m.joinUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{ marginLeft: 8, color: "var(--accent)", fontSize: 11 }}
                        >
                          Join →
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* End of Day Goals */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">End-of-Day Goals</div>
            <span style={{ fontSize: 18 }}>🎯</span>
          </div>
          {(priorities?.endOfDayGoals || []).length === 0 ? (
            <div className="empty-state">
              <div className="empty-text">No goals generated yet.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {(priorities?.endOfDayGoals || []).map((goal, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 8,
                    background: "var(--bg)",
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: "var(--green)", fontWeight: 700 }}>{i + 1}.</span>
                  <span>{goal}</span>
                </div>
              ))}
            </div>
          )}

          {/* Overdue items if any */}
          {(priorities?.overdueItems || []).length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="brief-section-title" style={{ color: "var(--red)" }}>
                ⚠️ Overdue
              </div>
              {priorities.overdueItems.map((item, i) => (
                <div key={i} style={{ fontSize: 13, padding: "4px 0", color: "var(--red)" }}>
                  • {item}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
