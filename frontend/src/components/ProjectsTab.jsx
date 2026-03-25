// src/components/ProjectsTab.jsx

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  getInbox,
  getEvents,
  getProjectsSummary,
  getProjectDetails,
  getUnresolvedIssues,
} from "../services/api";

// ─── Priority colours ────────────────────────────────────────────────────────
const PRIORITY = {
  high:   { bg: "#fef2f2", border: "#fca5a5", text: "#b91c1c", dot: "#ef4444" },
  medium: { bg: "#fffbeb", border: "#fcd34d", text: "#92400e", dot: "#f59e0b" },
  low:    { bg: "#f0fdf4", border: "#86efac", text: "#166534", dot: "#22c55e" },
};

const RISK = {
  high:   { bg: "#fef2f2", text: "#b91c1c", badge: "#ef4444" },
  medium: { bg: "#fffbeb", text: "#92400e", badge: "#f59e0b" },
  low:    { bg: "#f0fdf4", text: "#166534", badge: "#22c55e" },
};

// ─── Node type config — 5 nodes now, unresolved last ─────────────────────────
const NODE_CONFIG = [
  { id: "meetings",   label: "Meetings",   icon: "📅", color: "var(--accent)" },
  { id: "tasks",      label: "Tasks",      icon: "✅", color: "#8b5cf6"       },
  { id: "people",     label: "People",     icon: "👥", color: "#0891b2"       },
  { id: "threads",    label: "Threads",    icon: "📧", color: "#059669"       },
  { id: "unresolved", label: "Unresolved", icon: "🔁", color: "#d97706"       },
];

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function ProjectsTab() {
  const [projects,          setProjects]          = useState([]);
  const [unresolvedIssues,  setUnresolvedIssues]  = useState([]);
  const [loadingProjects,   setLoadingProjects]   = useState(true);
  const [loadingUnresolved, setLoadingUnresolved] = useState(true);
  const [error,             setError]             = useState(null);
  const [meetingCount,      setMeetingCount]      = useState(5);

  // Refs for each project card so banner can scroll to them
  const projectRefs = useRef({});

  // ── Load projects ──
  useEffect(() => {
    (async () => {
      setLoadingProjects(true);
      try {
        const [inboxRes, eventsRes] = await Promise.all([getInbox(40), getEvents()]);
        const threads = inboxRes.messages || [];
        const events  = eventsRes.events  || [];
        if (threads.length === 0) { setProjects([]); return; }
        const summary = await getProjectsSummary(threads, events);
        setProjects((summary.projects || []).map((p) => ({
          ...p, _loaded: false, _loading: false, _detail: null, _expanded: false,
        })));
      } catch (e) {
        setError(e.message);
      } finally {
        setLoadingProjects(false);
      }
    })();
  }, []);

  // ── Load unresolved issues ──
  useEffect(() => {
    (async () => {
      setLoadingUnresolved(true);
      try {
        const res = await getUnresolvedIssues(meetingCount);
        setUnresolvedIssues(res.issues || []);
      } catch {
        setUnresolvedIssues([]);
      } finally {
        setLoadingUnresolved(false);
      }
    })();
  }, [meetingCount]);

  // ── Lazy-load project detail on expand ──
  const handleExpand = useCallback(async (idx) => {
    setProjects((prev) => {
      const next = [...prev];
      const p    = next[idx];
      if (p._loaded || p._loading) {
        next[idx] = { ...p, _expanded: !p._expanded };
        return next;
      }
      next[idx] = { ...p, _expanded: true, _loading: true };
      return next;
    });

    const p = projects[idx];
    if (p._loaded || p._loading) return;

    try {
      const detail = await getProjectDetails(p.threadId, p.name, p.nextMeetingId);
      setProjects((prev) => {
        const next = [...prev];
        next[idx]  = { ...next[idx], _detail: detail, _loaded: true, _loading: false };
        return next;
      });
    } catch {
      setProjects((prev) => {
        const next = [...prev];
        next[idx]  = { ...next[idx], _loading: false, _loaded: true, _detail: null };
        return next;
      });
    }
  }, [projects]);

  // ── Scroll to project + expand it ──
  const handleScrollToProject = useCallback((projectName) => {
    const idx = projects.findIndex((p) =>
      p.name?.toLowerCase().includes(projectName?.toLowerCase())
    );
    if (idx === -1) return;

    // Expand if not already
    if (!projects[idx]._expanded) handleExpand(idx);

    // Scroll after a tick to let expansion render
    setTimeout(() => {
      const key = projects[idx].threadId || idx;
      projectRefs.current[key]?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
  }, [projects, handleExpand]);

  // Issues grouped by project for passing down
  const issuesForProject = (projectName) =>
    unresolvedIssues.filter((i) =>
      (i.affectedProjects || []).some((ap) =>
        ap.toLowerCase().includes((projectName || "").toLowerCase())
      )
    );

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>

      {/* ── Page header ── */}
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div className="page-title">🗂 Projects</div>
        <div className="page-subtitle">
          Active projects inferred from your inbox and calendar. Expand any project to explore its graph.
        </div>
      </div>

      {error && <div className="error-state">⚠️ {error}</div>}

      {/* ── Neutral unresolved issues banner ── */}
      {!loadingUnresolved && unresolvedIssues.length > 0 && (
        <UnresolvedBanner
          issues={unresolvedIssues}
          meetingCount={meetingCount}
          onChangeMeetingCount={setMeetingCount}
          onClickProject={handleScrollToProject}
        />
      )}

      {/* ── Projects list ── */}
      {loadingProjects ? (
        <div className="card loading-state">
          <div className="spinner" />
          <div className="loading-text">Analysing your inbox and calendar for active projects…</div>
        </div>
      ) : projects.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">🗂</div>
            <div className="empty-text">No active projects detected. Make sure your inbox has recent threads.</div>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {projects.map((project, idx) => {
            const key = project.threadId || idx;
            return (
              <div key={key} ref={(el) => { projectRefs.current[key] = el; }}>
                <ProjectCard
                  project={project}
                  unresolvedIssues={issuesForProject(project.name)}
                  onToggle={() => handleExpand(idx)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UnresolvedBanner — neutral strip, shows project source, clickable
// ─────────────────────────────────────────────────────────────────────────────
function UnresolvedBanner({ issues, meetingCount, onChangeMeetingCount, onClickProject }) {
  return (
    <div style={{
      background: "var(--bg, #f8f9fb)",
      border: "1px solid var(--border)",
      borderRadius: 10,
      padding: "12px 16px",
      marginBottom: 20,
    }}>
      {/* Header row */}
      <div style={{
        display: "flex", alignItems: "center",
        justifyContent: "space-between", gap: 10,
        marginBottom: 10, flexWrap: "wrap",
      }}>
        <span style={{
          fontSize: 12, fontWeight: 600,
          color: "var(--text-secondary)",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          🔁 Recurring unresolved
          <span style={{
            fontSize: 11, fontWeight: 500,
            color: "var(--text-tertiary)", fontStyle: "italic",
          }}>
            — topics that keep coming up without a decision
          </span>
        </span>

        {/* Meeting window selector */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Last</span>
          <select
            value={meetingCount}
            onChange={(e) => onChangeMeetingCount(Number(e.target.value))}
            style={{
              fontSize: 11, padding: "2px 6px", borderRadius: 6,
              border: "1px solid var(--border)", background: "var(--bg)",
              color: "var(--text-primary)", cursor: "pointer",
            }}
          >
            {[3, 5, 10, 15, 20].map((n) => (
              <option key={n} value={n}>{n} meetings</option>
            ))}
          </select>
        </div>
      </div>

      {/* Issue pills */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {issues.map((issue, i) => {
          const projectName = (issue.affectedProjects || [])[0] || null;
          return (
            <div
              key={i}
              onClick={() => projectName && onClickProject(projectName)}
              style={{
                fontSize: 12, padding: "5px 12px", borderRadius: 8,
                background: "var(--card-bg, white)",
                border: "1px solid var(--border)",
                color: "var(--text-primary)",
                display: "flex", alignItems: "center", gap: 8,
                cursor: projectName ? "pointer" : "default",
                transition: "border-color 0.15s, background 0.15s",
              }}
              onMouseEnter={(e) => {
                if (!projectName) return;
                e.currentTarget.style.borderColor = "var(--accent)";
                e.currentTarget.style.background  = "var(--accent-light)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border)";
                e.currentTarget.style.background  = "var(--card-bg, white)";
              }}
            >
              {/* Risk dot — small, not alarming */}
              <span style={{
                width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                background: RISK[issue.riskLevel]?.badge || RISK.medium.badge,
                opacity: 0.7,
              }} />

              {/* Issue name */}
              <span style={{ fontWeight: 500 }}>{issue.issue}</span>

              {/* ×count */}
              <span style={{
                fontSize: 11, color: "var(--text-tertiary)",
                fontWeight: 600,
              }}>
                ×{issue.meetingCount}
              </span>

              {/* Project source — clickable hint */}
              {projectName && (
                <span style={{
                  fontSize: 10, padding: "1px 6px", borderRadius: 6,
                  background: "var(--accent-light)",
                  color: "var(--accent)", fontWeight: 600,
                }}>
                  {projectName} ↗
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProjectCard
// ─────────────────────────────────────────────────────────────────────────────
function ProjectCard({ project, unresolvedIssues, onToggle }) {
  const p        = PRIORITY[project.priority] || PRIORITY.medium;
  const expanded = project._expanded;

  return (
    <div style={{
      border: `1px solid ${expanded ? "var(--accent)" : "var(--border)"}`,
      borderLeft: `4px solid ${p.dot}`,
      borderRadius: 10,
      overflow: "hidden",
      transition: "border-color 0.2s",
      background: "var(--card-bg, white)",
    }}>
      {/* Root node header */}
      <div
        onClick={onToggle}
        style={{
          padding: "16px 18px", cursor: "pointer", userSelect: "none",
          background: expanded ? "var(--accent-light)" : "transparent",
          transition: "background 0.15s",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
                background: p.bg, color: p.text, border: `1px solid ${p.border}`,
                textTransform: "uppercase", letterSpacing: "0.05em",
              }}>
                {project.priority || "medium"}
              </span>
              {project.nextMeeting && (
                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                  📅 {project.nextMeeting}
                </span>
              )}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
              {project.name}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {project.summary}
            </div>
            {project.keyTask && (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-secondary)", display: "flex", alignItems: "flex-start", gap: 6 }}>
                <span style={{ color: "#8b5cf6", fontWeight: 700, flexShrink: 0 }}>Key task:</span>
                {project.keyTask}
              </div>
            )}
          </div>
          <div style={{
            fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 8,
            background: expanded ? "var(--border)" : "var(--accent)",
            color: expanded ? "var(--text-secondary)" : "white",
            flexShrink: 0, whiteSpace: "nowrap",
            transition: "background 0.15s, color 0.15s",
          }}>
            {project._loading ? "Loading…" : expanded ? "▾ Collapse" : "▸ Explore"}
          </div>
        </div>
      </div>

      {/* Expanded graph */}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          {project._loading ? (
            <div className="loading-state" style={{ padding: 32 }}>
              <div className="spinner" />
              <div className="loading-text">Loading project details…</div>
            </div>
          ) : (
            <ProjectGraph
              project={project}
              detail={project._detail}
              unresolvedIssues={unresolvedIssues}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProjectGraph — 5-node graph
// ─────────────────────────────────────────────────────────────────────────────
function ProjectGraph({ project, detail, unresolvedIssues }) {
  const [activeNode, setActiveNode] = useState(null);

  const nodeCounts = {
    meetings:   (detail?.meetings     || []).length,
    tasks:      (detail?.pendingTasks || []).length,
    people:     (detail?.attendees    || []).length,
    threads:    (detail?.emailThreads || []).length,
    unresolved: unresolvedIssues.length,
  };

  const handleNode = (id) => setActiveNode(activeNode === id ? null : id);

  return (
    <div style={{ padding: "0 0 20px 0" }}>

      {/* Vertical stem from header */}
      <div style={{ display: "flex", justifyContent: "center" }}>
        <div style={{ width: 2, height: 24, background: "var(--accent)", opacity: 0.3 }} />
      </div>

      {/* Nodes row */}
      <div style={{ position: "relative", padding: "0 20px" }}>
        {/* Horizontal spine */}
        <div style={{
          position: "absolute", top: 0,
          left: "calc(10% + 20px)", right: "calc(10% + 20px)",
          height: 2, background: "var(--accent)", opacity: 0.15,
        }} />

        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          {NODE_CONFIG.map((node) => {
            const isActive  = activeNode === node.id;
            const count     = nodeCounts[node.id];
            const hasIssues = node.id === "unresolved" && count > 0;

            return (
              <div
                key={node.id}
                style={{ flex: 1, maxWidth: 160, display: "flex", flexDirection: "column", alignItems: "center" }}
              >
                {/* Drop line */}
                <div style={{ width: 2, height: 20, background: "var(--accent)", opacity: 0.2 }} />

                {/* Node button */}
                <button
                  onClick={() => handleNode(node.id)}
                  style={{
                    width: "100%", padding: "10px 6px", borderRadius: 10, cursor: "pointer",
                    border: `2px solid ${isActive ? node.color : hasIssues ? "#d9770630" : "var(--border)"}`,
                    background: isActive ? `${node.color}15` : "var(--bg)",
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                    transition: "all 0.15s", outline: "none",
                  }}
                >
                  <span style={{ fontSize: 18 }}>{node.icon}</span>
                  <span style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: "0.03em",
                    color: isActive ? node.color : "var(--text-secondary)",
                  }}>
                    {node.label}
                  </span>
                  {count > 0 && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 10,
                      background: isActive ? node.color : hasIssues ? "#d9770620" : "var(--border)",
                      color: isActive ? "white" : hasIssues ? "#d97706" : "var(--text-tertiary)",
                    }}>
                      {count}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Active node content */}
      {activeNode && (
        <>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <div style={{ width: 2, height: 16, background: "var(--accent)", opacity: 0.2 }} />
          </div>
          <div style={{ margin: "0 20px", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            {activeNode === "unresolved" ? (
              <UnresolvedNodeContent issues={unresolvedIssues} />
            ) : (
              <NodeContent nodeId={activeNode} project={project} detail={detail} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UnresolvedNodeContent — shown when Unresolved node is active
// ─────────────────────────────────────────────────────────────────────────────
function UnresolvedNodeContent({ issues }) {
  const cfg = NODE_CONFIG.find((n) => n.id === "unresolved");

  return (
    <div>
      <div style={{
        padding: "10px 16px",
        background: "#d9770610",
        borderBottom: "1px solid var(--border)",
        fontSize: 12, fontWeight: 700, color: "#d97706",
        display: "flex", alignItems: "center", gap: 6,
        textTransform: "uppercase", letterSpacing: "0.05em",
      }}>
        {cfg.icon} Unresolved Issues
      </div>

      {issues.length === 0 ? (
        <div style={{ padding: 20, fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic", textAlign: "center" }}>
          No recurring unresolved issues detected for this project.
        </div>
      ) : (
        issues.map((issue, i) => (
          <div key={i} style={{
            padding: "12px 16px",
            borderBottom: i < issues.length - 1 ? "1px solid var(--border)" : "none",
            display: "flex", alignItems: "flex-start", gap: 12,
          }}>
            {/* Risk dot */}
            <span style={{
              width: 8, height: 8, borderRadius: "50%", flexShrink: 0, marginTop: 4,
              background: RISK[issue.riskLevel]?.badge || RISK.medium.badge,
              opacity: 0.8,
            }} />

            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                  {issue.issue}
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, flexShrink: 0,
                  background: RISK[issue.riskLevel]?.bg || RISK.medium.bg,
                  color: RISK[issue.riskLevel]?.text || RISK.medium.text,
                }}>
                  {issue.riskLevel || "medium"} risk
                </span>
              </div>

              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 3, display: "flex", gap: 12, flexWrap: "wrap" }}>
                <span>Seen in <strong>{issue.meetingCount}</strong> meeting{issue.meetingCount !== 1 ? "s" : ""}</span>
                {issue.lastSeen && (
                  <span>Last: {new Date(issue.lastSeen).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                )}
              </div>

              {issue.suggestion && (
                <div style={{
                  marginTop: 6, fontSize: 12, padding: "5px 10px", borderRadius: 6,
                  background: "var(--bg)", color: "var(--text-secondary)",
                  borderLeft: "3px solid var(--accent)",
                }}>
                  💡 {issue.suggestion}
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NodeContent — meetings / tasks / people / threads
// ─────────────────────────────────────────────────────────────────────────────
function NodeContent({ nodeId, project, detail }) {
  const cfg = NODE_CONFIG.find((n) => n.id === nodeId);

  const headerStyle = {
    padding: "10px 16px",
    background: `${cfg.color}10`,
    borderBottom: "1px solid var(--border)",
    fontSize: 12, fontWeight: 700, color: cfg.color,
    display: "flex", alignItems: "center", gap: 6,
    textTransform: "uppercase", letterSpacing: "0.05em",
  };

  if (nodeId === "meetings") {
    const meetings = detail?.meetings || [];
    return (
      <div>
        <div style={headerStyle}>{cfg.icon} Meetings</div>
        {meetings.length === 0 ? (
          <EmptyNode message="No meeting records found. Run post-call processing after a meeting to populate this." />
        ) : (
          meetings.map((m, i) => (
            <div key={i} style={{ padding: "12px 16px", borderBottom: i < meetings.length - 1 ? "1px solid var(--border)" : "none" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", flex: 1 }}>{m.subject}</div>
                {m.date && (
                  <span style={{ fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap", flexShrink: 0 }}>
                    {new Date(m.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                  </span>
                )}
              </div>
              {m.summary && (
                <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55, marginBottom: 6 }}>{m.summary}</div>
              )}
              {(m.actionItems || []).length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {m.actionItems.slice(0, 3).map((a, j) => (
                    <span key={j} style={{
                      fontSize: 11, padding: "2px 8px", borderRadius: 12,
                      background: a.status === "done" ? "var(--green-light)" : "#fff7ed",
                      color: a.status === "done" ? "var(--green)" : "#c2410c",
                      border: `1px solid ${a.status === "done" ? "var(--green)" : "#fed7aa"}`,
                    }}>
                      {a.status === "done" ? "✓" : "⏳"} {a.owner}: {(a.task || "").slice(0, 40)}
                    </span>
                  ))}
                  {m.actionItems.length > 3 && (
                    <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>+{m.actionItems.length - 3} more</span>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    );
  }

  if (nodeId === "tasks") {
    const tasks = detail?.pendingTasks || [];
    return (
      <div>
        <div style={headerStyle}>{cfg.icon} Pending Tasks</div>
        {tasks.length === 0 ? (
          <EmptyNode message="No pending tasks found in approval queue for this project." />
        ) : (
          tasks.map((t, i) => (
            <div key={i} style={{ padding: "10px 16px", display: "flex", alignItems: "flex-start", gap: 10, borderBottom: i < tasks.length - 1 ? "1px solid var(--border)" : "none" }}>
              <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>
                {t.type === "email" ? "📧" : t.type === "calendar" ? "📅" : t.type === "reminder" ? "🔔" : "✅"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "var(--text-primary)", wordBreak: "break-word" }}>{t.label}</div>
                {t.data?.urgency && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8, marginTop: 4, display: "inline-block",
                    background: t.data.urgency === "high" ? "#fef2f2" : t.data.urgency === "medium" ? "#fffbeb" : "#f0fdf4",
                    color: t.data.urgency === "high" ? "#b91c1c" : t.data.urgency === "medium" ? "#92400e" : "#166534",
                  }}>
                    {t.data.urgency}
                  </span>
                )}
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: "#fff7ed", color: "#c2410c", flexShrink: 0 }}>
                pending
              </span>
            </div>
          ))
        )}
      </div>
    );
  }

  if (nodeId === "people") {
    const attendees = detail?.attendees || [];
    return (
      <div>
        <div style={headerStyle}>{cfg.icon} Key People</div>
        {attendees.length === 0 ? (
          <EmptyNode message="No attendee data found. Run post-call processing to populate." />
        ) : (
          <div style={{ padding: "12px 16px", display: "flex", flexWrap: "wrap", gap: 10 }}>
            {attendees.map((a, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)" }}>
                <div style={{
                  width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
                  background: `hsl(${((a.name || "").charCodeAt(0) * 37) % 360}, 60%, 85%)`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, fontWeight: 700,
                  color: `hsl(${((a.name || "").charCodeAt(0) * 37) % 360}, 60%, 30%)`,
                }}>
                  {(a.name || a.email || "?").charAt(0).toUpperCase()}
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{a.name || a.email}</div>
                  {a.taskCount > 0 && (
                    <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{a.taskCount} task{a.taskCount !== 1 ? "s" : ""} assigned</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (nodeId === "threads") {
    const threads = detail?.emailThreads || [];
    return (
      <div>
        <div style={headerStyle}>{cfg.icon} Email Threads</div>
        {threads.length === 0 ? (
          <EmptyNode message="No email threads linked to this project." />
        ) : (
          threads.map((t, i) => (
            <div key={i} style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: i < threads.length - 1 ? "1px solid var(--border)" : "none" }}>
              <span style={{ fontSize: 14, flexShrink: 0 }}>📧</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", wordBreak: "break-word" }}>{t.subject}</div>
                {t.latestDate && (
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                    Last activity: {new Date(t.latestDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                    {t.messageCount && ` · ${t.messageCount} messages`}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    );
  }

  return null;
}

function EmptyNode({ message }) {
  return (
    <div style={{ padding: 20, fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic", textAlign: "center" }}>
      {message}
    </div>
  );
}