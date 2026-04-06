import React, { useState } from "react";
import { MsalProvider, useMsal, useIsAuthenticated } from "@azure/msal-react";
import { msalInstance, loginRequest, getCurrentUser } from "./services/auth";
import DailyTodos from "./components/DailyTodos";
import PreCallBrief from "./components/PreCallBrief";
import PostCallPanel from "./components/PostCallPanel";
import ThreadCatchup from "./components/ThreadCatchup";
import ProjectsTab from "./components/ProjectsTab";
import FocusGraphTab from "./components/FocusGraphTab";
import "./App.css";
import dispatchLogo from "./assets/dispatch-logo.png";

const TABS = [
  { id: "daily", label: "Daily View", icon: "📋" },
  { id: "pre-call", label: "Pre-Call Brief", icon: "📅" },
  { id: "post-call", label: "Post-Call", icon: "✅" },
  { id: "threads", label: "Thread Catch-Up", icon: "📧" },
  { id: "projects", label: "Projects", icon: "🗂" },
  { id: "focus", label: "Focus Graph", icon: "🎯" },
];

function SignInScreen() {
  const { instance } = useMsal();

  const handleLogin = async () => {
    try {
      await instance.loginPopup(loginRequest);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  return (
    <div className="signin-screen">
      <div className="signin-card">
        <div className="dispatch-logo" style={{ flexDirection: "column", gap: 4 }}>
          <img src={dispatchLogo} alt="Dispatch" style={{ width: 110, height: 75, objectFit: "contain" }} />
          <span className="logo-text">Dispatch</span>
        </div>
        <p className="signin-tagline-1">Your personal AI assistant.</p>
        <p className="signin-tagline">Walk in prepared, leave without loose ends.</p>
        <div className="signin-features">
          <div className="feature-pill">📅 Pre-Call Briefs</div>
          <div className="feature-pill">✅ Action Item Capture</div>
          <div className="feature-pill">📧 Thread Catch-Up</div>
          <div className="feature-pill">📋 Daily Priorities</div>
        </div>
        <button className="ms-signin-btn" onClick={handleLogin}>
          <img
            src="https://learn.microsoft.com/en-us/azure/active-directory/develop/media/howto-add-branding-in-apps/ms-symbollockup_mssymbol_19.svg"
            alt="Microsoft"
            className="ms-logo"
            onError={(event) => {
              event.target.style.display = "none";
            }}
          />
          Sign in with Microsoft
        </button>
        <p className="signin-note">
          Dispatch connects to your Microsoft 365 account. All data stays within your organization&apos;s Azure tenant.
        </p>
      </div>
    </div>
  );
}

function AppShell() {
  const isAuthenticated = useIsAuthenticated();
  const { instance } = useMsal();
  const [activeTab, setActiveTab] = useState("daily");
  const [projectJump, setProjectJump] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const user = getCurrentUser();

  const handleLogout = () => instance.logoutPopup();

  const openProjectFromFocus = (projectRef) => {
    if (!projectRef) return;
    if (typeof projectRef === "string") {
      setProjectJump({ projectName: projectRef, token: Date.now() });
    } else {
      setProjectJump({ ...projectRef, token: Date.now() });
    }
    setActiveTab("projects");
  };

  if (!isAuthenticated) return <SignInScreen />;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <div className="sidebar-brand" style={{ gap: 6, padding: "16px 12px" }}>
          <img src={dispatchLogo} alt="Dispatch" style={{ width: 40, height: 27, objectFit: "contain", flexShrink: 0 }} />
          <span className="logo-text">Dispatch</span>
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed((current) => !current)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? ">" : "<"}
          </button>
        </div>

        <nav className="sidebar-nav">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`nav-item ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="nav-icon">{tab.icon}</span>
              <span className="nav-label">{tab.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="user-avatar">
              {user?.name?.charAt(0)?.toUpperCase() || "U"}
            </div>
            <div className="user-details">
              <div className="user-name">{user?.name || "User"}</div>
              <div className="user-email">{user?.email || ""}</div>
            </div>
          </div>
          <button className="signout-btn" onClick={handleLogout} title="Sign out">
            ↪
          </button>
        </div>
      </aside>

      <main className={`main-content ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        {activeTab === "daily" && <DailyTodos />}
        {activeTab === "pre-call" && <PreCallBrief />}
        {activeTab === "post-call" && <PostCallPanel />}
        {activeTab === "threads" && <ThreadCatchup />}
        {activeTab === "projects" && <ProjectsTab deepLinkProject={projectJump} />}
        {activeTab === "focus" && <FocusGraphTab onGoDeeper={openProjectFromFocus} />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <MsalProvider instance={msalInstance}>
      <AppShell />
    </MsalProvider>
  );
}
