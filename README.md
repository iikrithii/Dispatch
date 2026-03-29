# Dispatch — AI Meeting Layer for Microsoft 365

> This is a prototype which is currently submitted to Microsoft AI Unlocked — Phase 2

---

## Hosted App

Try Dispatch here: [https://blue-hill-03f693c00.1.azurestaticapps.net](https://blue-hill-03f693c00.1.azurestaticapps.net)

> This prototype opens in a preloaded demo workspace so you can evaluate the experience immediately without spending time on sign-in or account setup. Some actions are intentionally sandboxed to the demo user for reliability during judging, but the underlying flows, reasoning, and UI behavior reflect how the product works with a real connected account.

---

## What is Dispatch?

Dispatch is an AI layer that sits on top of Microsoft 365 and cuts down the context-switching cost of meetings. It surfaces the right information at the right transition — before a call, after a call, and in between.

---

## Features

### Pre-Call Brief
Before any meeting, Dispatch reads your calendar event, cross-references your recent emails, and pulls relevant past meeting records from its memory. It surfaces:
- **Current status** of the project or topic
- **Last meeting recap** — with every action item marked ✅ DONE or ⏳ PENDING, cross-referenced against your inbox
- **Open points** extracted directly from email thread content
- **Agenda for today** — focused on what is still unresolved
- **Key context** — the most important thing from the emails you need to know walking in
- **Jira-linked issues** — open work items and blockers that still need attention
- **Join link** — one click to enter the call

### Post-Call Processing
Paste a meeting transcript and Dispatch extracts:
- Structured action items with owner, deadline, and urgency
- Soft commitments ("I’ll send that over") as separate tracked items
- Drafted follow-up emails ready to send
- Suggested follow-up meeting with agenda
- Key decisions made
- Meeting effectiveness and engagement analysis

Everything goes into an **approval queue first**. Dispatch proposes, you decide. Approved items are saved from the queue. Tasks are no longer pushed into Microsoft To Do; the post-call flow now focuses on drafts, reminders, and follow-ups.

### Thread Catch-Up
Select any email thread from your inbox. Dispatch reads the full conversation and gives you a 3-line summary: what this is about, where it stands right now, and what is expected of you — with a suggested reply if action is needed.

### Daily View
An AI-prioritised view combining today's meetings, pending approvals, urgent emails needing a response, dispatch tasks, and reminders. It keeps noise out so only what matters surfaces.

### Projects
Dispatch clusters your inbox, meetings, and unresolved issues into a project graph. Open a project to see its summary, recent meetings, people involved, linked threads, key tasks, and unresolved work. You can also generate a handover report for any project.

### Speaking Points
Dispatch can turn rough prompts into polished meeting speaking points. It is useful when you want to capture what you need to say first and clean it up later, including code-mixed or voice input.

---

## Architecture

```
dispatch/
├── backend/                          # Azure Functions (Node.js 18)
│   ├── src/
│   │   ├── functions/                # Each HTTP trigger lives here
│   │   │   ├── approveItem.js        # POST /api/approve-item
│   │   │   ├── dailyTodos.js         # GET /api/daily-todos
│   │   │   ├── getEvents.js          # GET /api/events
│   │   │   ├── getHandoverReport.js  # GET /api/handover-report
│   │   │   ├── getInbox.js           # GET /api/inbox
│   │   │   ├── getProjectDetails.js  # GET /api/project-details
│   │   │   ├── getProjectsSummary.js # POST /api/projects-summary
│   │   │   ├── getUnresolvedIssues.js # GET /api/unresolved-issues
│   │   │   ├── meetingNotes.js       # POST /api/meeting-notes
│   │   │   ├── postMeetingProcess.js  # POST /api/post-meeting-process
│   │   │   ├── preMeetingBrief.js    # GET /api/pre-meeting-brief?eventId=
│   │   │   └── threadCatchup.js      # GET/POST /api/thread-catchup
│   │   ├── services/                 # Data, AI, and Jira helpers
│   │   │   ├── cosmosService.js      # Cosmos DB — meeting history, approvals, reminders
│   │   │   ├── graphService.js       # Microsoft Graph API calls
│   │   │   ├── jiraMockData.js       # Demo Jira data
│   │   │   ├── jiraService.js        # Jira issue matching and cards
│   │   │   ├── openaiService.js      # AI completions
│   │   │   └── test-buildPreCallExecutionContext.js
│   │   └── utils/
│   │       └── auth.js               # Token extraction and response helpers
│   ├── host.json
│   ├── local.settings.json           # Environment variables (not committed)
│   └── package.json
│
├── frontend/                         # React 18 + MSAL
│   ├── public/
│   ├── src/
│   │   ├── assets/                   # Logos and app images
│   │   ├── components/
│   │   │   ├── DailyTodos.jsx
│   │   │   ├── MeetingNotes.jsx
│   │   │   ├── PostCallPanel.jsx
│   │   │   ├── PreCallBrief.jsx
│   │   │   ├── ProjectsTab.jsx
│   │   │   └── ThreadCatchup.jsx
│   │   ├── services/
│   │   │   ├── api.js                # Backend API client
│   │   │   └── auth.js               # MSAL config + token helpers
│   │   ├── App.jsx
│   │   ├── App.css
│   │   └── index.js
│   └── package.json
│
├── gallery/                          # Screenshots and presentation images
│   ├── home.png
│   ├── post-call.png
│   ├── post-callui.png
│   ├── precall.png
│   ├── signin.png
│   └── threadcatchup.png
│
└── teams-manifest/
    └── manifest.json                 # Teams app manifest for sideloading
```

### Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, MSAL (`@azure/msal-browser`) |
| Backend | Azure Functions v4, Node.js 18 |
| AI | Azure OpenAI or Groq through the OpenAI SDK |
| Data | Microsoft Graph API (Calendar, Mail, Tasks) |
| Storage | Azure Cosmos DB (serverless) |
| Auth | Microsoft Identity Platform — supports personal + org accounts |
| Hosting | Azure Static Web Apps (frontend) + Azure Function App (backend) |

The backend folder keeps the HTTP routes separate from the service layer so the functions stay small. The frontend keeps UI panels in `components/`, token and auth logic in `services/auth.js`, and API calls in `services/api.js`.

---

## Prerequisites

- Node.js 18+
- Azure Functions Core Tools v4: `npm install -g azure-functions-core-tools@4`
- An Azure account (Azure for Students works)
- A Microsoft account (personal Outlook or organisational)

---

## Azure Setup

All resources must be in a supported region for your subscription.

### 1. Azure App Registration

1. Go to [portal.azure.com](https://portal.azure.com) → **Azure Active Directory** → **App registrations** → **New registration**
2. Name: `Dispatch`
3. Supported account types: **Accounts in any organizational directory AND personal Microsoft accounts**
4. Redirect URI: `http://localhost:3000` (Single-page application)
5. After creation, go to **Manifest** and confirm:
   ```json
   "signInAudience": "AzureADandPersonalMicrosoftAccount"
   ```
6. Go to **API permissions** → Add the following Microsoft Graph **delegated** permissions:
   - `User.Read`
   - `Calendars.ReadWrite`
   - `Mail.ReadWrite`
   - `Mail.Send`
   - `Tasks.ReadWrite`
7. Click **Grant admin consent**
8. Note your **Application (client) ID** and **Directory (tenant) ID**
9. If your backend uses a client secret for any server-side Graph or app-auth flow, note the **Client secret** too

### 2. Azure Cosmos DB

1. Create a **Cosmos DB** account → API: **Azure Cosmos DB for NoSQL** → Region: use a supported region for your subscription → Capacity: **Serverless**
2. Create database: `dispatch`
3. Create container: `tasks` with partition key `/userId`
4. Go to **Keys** → note the **URI** and **Primary Key**

### 3. AI Provider Setup

Dispatch supports two backends for AI calls:

**Option A: Azure OpenAI**
1. Set `AZURE_OPENAI_ENDPOINT`
2. Set `AZURE_OPENAI_KEY`
3. Set `AZURE_OPENAI_DEPLOYMENT`

**Option B: Groq fallback**
1. Set `GROQ_API_KEY`

If Azure OpenAI is set, Dispatch uses it. Otherwise it falls back to Groq.

---

## Local Development Setup

### 1. Install dependencies

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Configure backend environment

Edit `backend/local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR": "true",
    "AZURE_OPENAI_ENDPOINT": "https://YOUR_RESOURCE.openai.azure.com/",
    "AZURE_OPENAI_KEY": "YOUR_AZURE_OPENAI_KEY",
    "AZURE_OPENAI_DEPLOYMENT": "gpt-4o",
    "GROQ_API_KEY": "YOUR_GROQ_API_KEY",
    "COSMOS_ENDPOINT": "https://YOUR_COSMOS.documents.azure.com:443/",
    "COSMOS_KEY": "YOUR_COSMOS_KEY",
    "COSMOS_DATABASE": "dispatch",
    "COSMOS_CONTAINER": "tasks",
    "AZURE_TENANT_ID": "YOUR_TENANT_ID",
    "AZURE_CLIENT_ID": "YOUR_CLIENT_ID",
    "AZURE_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
    "ALLOWED_ORIGINS": "http://localhost:3000"
  },
  "Host": {
    "LocalHttpPort": 7071,
    "CORS": "*",
    "CORSCredentials": false
  }
}
```

### 3. Configure frontend environment

Create `frontend/.env`:

```env
REACT_APP_CLIENT_ID=<your App Registration client ID>
REACT_APP_API_URL=http://localhost:7071/api
HTTPS=true
```

`REACT_APP_TENANT_ID` is no longer needed because the app uses the `common` authority directly in `frontend/src/services/auth.js`.

### 4. Start the backend

```bash
cd backend
func start
```

The routes should appear in the terminal, including:
```
GET  http://localhost:7071/api/events
GET  http://localhost:7071/api/inbox
GET  http://localhost:7071/api/pre-meeting-brief
POST http://localhost:7071/api/post-meeting-process
GET/POST http://localhost:7071/api/thread-catchup
GET  http://localhost:7071/api/daily-todos
POST http://localhost:7071/api/approve-item
GET  http://localhost:7071/api/project-details
POST http://localhost:7071/api/projects-summary
GET  http://localhost:7071/api/unresolved-issues
POST http://localhost:7071/api/meeting-notes
GET  http://localhost:7071/api/handover-report
```

### 5. Start the frontend

```bash
cd frontend
npm start
```

Frontend runs at `https://localhost:3000`. Sign in with your Microsoft account when prompted.

---

## Deploy to Azure

Once it works locally, deploying to Azure takes about 20 minutes.

---

## Log in to Azure CLI

```bash
az login
```

A browser window opens → sign in with `admin@YOURNAME.onmicrosoft.com` → close the window → your terminal will confirm you're logged in.

---

## Set Environment Variables on the Function App

Run this block and replace the `YOUR_X` values with your real values:

```bash
az functionapp config appsettings set   --name dispatch-api-YOURNAME   --resource-group dispatch-rg   --settings   "AZURE_OPENAI_ENDPOINT=https://dispatch-openai.openai.azure.com/"   "AZURE_OPENAI_KEY=your_actual_key"   "AZURE_OPENAI_DEPLOYMENT=gpt-4o"   "GROQ_API_KEY=your_groq_key_if_needed"   "COSMOS_ENDPOINT=https://dispatch-cosmos-yourname.documents.azure.com:443/"   "COSMOS_KEY=your_actual_cosmos_key"   "COSMOS_DATABASE=dispatch"   "COSMOS_CONTAINER=tasks"   "AZURE_TENANT_ID=your_tenant_id"   "AZURE_CLIENT_ID=your_client_id"   "AZURE_CLIENT_SECRET=your_client_secret"   "ALLOWED_ORIGINS=*"
```

---

## Deploy the Backend

```bash
cd dispatch/backend
func azure functionapp publish dispatch-api-YOURNAME
```

Takes ~2 minutes. At the end you'll see the functions listed in the terminal.

Your API is now live at: `https://dispatch-api-YOURNAME.azurewebsites.net/api`

---

## Create the Static Web App for the Frontend

```bash
az staticwebapp create   --name dispatch-frontend   --resource-group dispatch-rg   --location eastus2
```

---

## Update Frontend .env for Production

Open `dispatch/frontend/.env` and change the API URL:

```env
REACT_APP_CLIENT_ID=your_client_id
REACT_APP_API_URL=https://dispatch-api-YOURNAME.azurewebsites.net/api
```

---

## Build and Deploy the Frontend

```bash
cd dispatch/frontend
npm run build
```

Wait ~1 minute for the build to complete. Then:

```bash
npm install -g @azure/static-web-apps-cli
swa login
```

Then deploy:

```bash
swa deploy ./build --deployment-token PASTE_TOKEN_HERE --env production
```

Your live URL will print at the end: `https://something.azurestaticapps.net`

---

## Add Production URL to App Registration

1. Azure Portal → App registrations → Dispatch → Authentication
2. Under "Single-page application", click **Add URI**
3. Add: `https://your-app-name.azurestaticapps.net`
4. Click **Save**

---

## Add CORS to Function App

```bash
az functionapp cors add   --name dispatch-api-YOURNAME   --resource-group dispatch-rg   --allowed-origins "https://your-app-name.azurestaticapps.net"
```

---

## Done. Your app is live.

Test the production URL in your browser — same flow as local testing.

---

## Microsoft Teams Sideloading

Run Dispatch inside Microsoft Teams as a personal app.

### 1. Ensure HTTPS is on

`frontend/.env` must contain `HTTPS=true`. Restart `npm start`.

### 2. Update the manifest

Edit `teams-manifest/manifest.json` — set all URLs to `https://localhost:3000`:
```json
"contentUrl": "https://localhost:3000?tab=daily",
"validDomains": ["localhost:3000", "localhost:7071"]
```

### 3. Package and sideload

```bash
cd teams-manifest
# On Windows:
Compress-Archive -Path manifest.json, <icon-files> -DestinationPath dispatch-manifest.zip
# On Mac/Linux:
zip dispatch-manifest.zip manifest.json <icon-files>
```

In Microsoft Teams → **Apps** → **Manage your apps** → **Upload a custom app** → select `dispatch-manifest.zip`.

Dispatch appears as a personal app with five tabs: Daily View, Pre-Call Brief, Post-Call, Thread Catch-Up, and Projects.

---

## API Reference

All endpoints require `Authorization: Bearer <access_token>`. The token is the Microsoft Graph delegated token obtained via MSAL.

| Method | Route | Description |
|---|---|---|
| GET | `/api/events` | Calendar events for today and the next 7 days |
| GET | `/api/inbox?limit=` | Recent inbox message threads |
| GET | `/api/pre-meeting-brief?eventId=` | AI pre-call brief for a specific event |
| POST | `/api/post-meeting-process` | Process transcript → follow-ups, drafts, effectiveness, engagement |
| GET / POST | `/api/thread-catchup` | 3-line email thread summary |
| POST | `/api/projects-summary` | Cluster inbox threads into project summaries |
| GET | `/api/daily-todos` | AI-prioritised daily view |
| POST | `/api/approve-item` | Approve an item from the queue |
| POST | `/api/meeting-notes` | Generate polished speaking points |
| GET | `/api/project-details?threadId=&projectName=&nextMeetingId=` | Full project detail view |
| GET | `/api/unresolved-issues?limit=` | Recent unresolved issues |
| GET | `/api/handover-report?threadId=&projectName=` | Generate a project handover PDF |

**POST /api/post-meeting-process body:**
```json
{
  "meetingId": "optional meeting ID",
  "eventId": "optional calendar event ID",
  "transcript": "Full meeting transcript text..."
}
```

**POST /api/meeting-notes body:**
```json
{
  "eventId": "optional calendar event ID",
  "meetingTitle": "Meeting title",
  "language": "English",
  "agenda": [],
  "followUpItems": [],
  "openPoints": [],
  "keyContext": "",
  "currentStatus": "",
  "questions": [],
  "answers": {},
  "additionalNotes": ""
}
```

**POST /api/approve-item body:**
```json
{
  "batchId": "pending_batch_id",
  "itemId": "ai_001",
  "action": "approve"
}
```

---

## Key Design Decisions

**"Dispatch proposes, humans decide"** — Every AI output (drafts, follow-ups, reminders, calendar invites) goes into an approval queue before any action is taken in Microsoft 365. Nothing executes without explicit user approval.

**Common authority** — The frontend uses the Microsoft `common` authority directly, so the same sign-in flow works with personal and organisational Microsoft accounts.

**Project-first context** — The projects tab clusters inbox threads and meetings into a graph, then loads project details lazily when you open a project. That keeps the main view lighter while still giving deep context on demand.

**Jira-aware briefs** — The pre-call brief pulls in Jira-linked issues and flags cases where email updates and Jira status do not match.

**Standalone and Teams-ready** — The app runs as a normal web app for local development and can also be sideloaded into Microsoft Teams for demo use.

---

## Environment Variables Reference

### Backend (`local.settings.json` → `Values`)

| Variable | Where to get it |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource endpoint |
| `AZURE_OPENAI_KEY` | Azure OpenAI key |
| `AZURE_OPENAI_DEPLOYMENT` | Azure OpenAI deployment name |
| `GROQ_API_KEY` | Groq API key, if using fallback |
| `COSMOS_ENDPOINT` | Azure Portal → Cosmos DB → Keys → URI |
| `COSMOS_KEY` | Azure Portal → Cosmos DB → Keys → Primary Key |
| `COSMOS_DATABASE` | `dispatch` (default) |
| `COSMOS_CONTAINER` | `tasks` (default) |
| `AZURE_TENANT_ID` | Azure Portal → App Registration → Overview |
| `AZURE_CLIENT_ID` | Azure Portal → App Registration → Overview |
| `AZURE_CLIENT_SECRET` | Azure Portal → App Registration → Certificates & secrets |
| `ALLOWED_ORIGINS` | `http://localhost:3000` for local dev |

### Frontend (`.env`)

| Variable | Value |
|---|---|
| `REACT_APP_CLIENT_ID` | App Registration client ID |
| `REACT_APP_API_URL` | `http://localhost:7071/api` |
| `HTTPS` | `true` (required for Teams sideloading) |

---

## Team

**Icebreakers — IIT Madras**  
Contact: da25s009@smail.iitm.ac.in

Built for Microsoft AI Unlocked Phase 5, March 2026.
