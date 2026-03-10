# Dispatch — AI Meeting Layer for Microsoft 365
 
> This is a prototype which is currently submitted to Microsoft AI Unlocked — Phase 2  

---

## What is Dispatch?

Dispatch is an AI layer that sits on top of Microsoft 365 and eliminates the context-switching tax of meetings. It surfaces the right information at the right transition — before a call, after a call, and in between.

---

## Features

### Pre-Call Brief
Before any meeting, Dispatch reads your calendar event, cross-references your recent emails, and pulls relevant past meeting records from its memory. It surfaces:
- **Current status** of the project or topic
- **Last meeting recap** — with every action item marked ✅ DONE or ⏳ PENDING, cross-referenced against your inbox
- **Open points** extracted directly from email thread content
- **Agenda for today** — focused on what's still unresolved
- **Key context** — the single most critical thing from the emails you need to know walking in
- **Join link** — one click to enter the call

### Post-Call Processing
Paste a meeting transcript and Dispatch extracts:
- Structured action items with owner, deadline, and urgency
- Soft commitments ("I'll send that over") as separate tracked items
- Drafted follow-up emails ready to send
- Suggested follow-up meeting with agenda
- Key decisions made

Everything goes into an **approval queue first**. Dispatch proposes, you decide. Approved tasks land in Microsoft To-Do. Approved emails go to your Outlook Drafts. Approved calendar invites create the event.

### Thread Catch-Up
Select any email thread from your inbox. Dispatch reads the full conversation and gives you a 3-line summary: what this is about, where it stands right now, and what's expected of you — with a suggested reply if action is needed.

### Daily View
An AI-prioritised view combining today's meetings, pending tasks from Microsoft To-Do, and urgent emails needing a response. Filters noise so only what matters surfaces.

---

## Architecture

```
dispatch/
├── backend/                          # Azure Functions (Node.js 18)
│   ├── src/
│   │   ├── functions/
│   │   │   ├── preMeetingBrief.js    # GET /api/pre-meeting-brief?eventId=
│   │   │   ├── postMeetingProcess.js # POST /api/post-meeting-process
│   │   │   ├── threadCatchup.js      # GET /api/thread-catchup?conversationId=
│   │   │   ├── dailyTodos.js         # GET /api/daily-todos
│   │   │   ├── approveItem.js        # POST /api/approve-item
│   │   │   ├── getEvents.js          # GET /api/get-events
│   │   │   └── getInbox.js           # GET /api/get-inbox
│   │   ├── services/
│   │   │   ├── graphService.js       # All Microsoft Graph API calls
│   │   │   ├── openaiService.js      # All AI completions (GPT-4o via GitHub Models)
│   │   │   └── cosmosService.js      # Cosmos DB — meeting history, approval queue
│   │   └── utils/
│   │       └── auth.js               # JWT decode, userId extraction
│   ├── host.json
│   ├── local.settings.json           # Environment variables (not committed)
│   ├── seed-meetings.js              # One-time script to seed demo past meetings
│   └── package.json
│
├── frontend/                         # React 18 + MSAL
│   ├── src/
│   │   ├── components/
│   │   │   ├── PreCallBrief.jsx
│   │   │   ├── PostCallPanel.jsx
│   │   │   ├── ThreadCatchup.jsx
│   │   │   └── DailyTodos.jsx
│   │   ├── services/
│   │   │   ├── auth.js               # MSAL config + token helpers
│   │   │   └── api.js                # Backend API client
│   │   ├── App.jsx
│   │   └── App.css
│   ├── .env                          # REACT_APP_CLIENT_ID, REACT_APP_API_URL
│   └── package.json
│
└── teams-manifest/
    └── manifest.json                 # Teams app manifest for sideloading
```

### Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, MSAL (`@azure/msal-browser`) |
| Backend | Azure Functions v4, Node.js 18 |
| AI | GPT-5o/Groq |
| Data | Microsoft Graph API (Calendar, Mail, Tasks) |
| Storage | Azure Cosmos DB (serverless, Korea Central) |
| Auth | Microsoft Identity Platform — supports personal + org accounts |
| Hosting | Azure Static Web Apps (frontend) + Azure Function App (backend) |

---

## Prerequisites

- Node.js 18+
- Azure Functions Core Tools v4: `npm install -g azure-functions-core-tools@4`
- An Azure account (Azure for Students works)
- A Microsoft account (personal Outlook or organisational)

---

## Azure Setup

All resources must be in a supported region for your subscription. For Azure for Students, use **Korea Central**.

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

### 2. Azure Cosmos DB

1. Create a **Cosmos DB** account → API: **Azure Cosmos DB for NoSQL** → Region: Korea Central → Capacity: **Serverless**
2. Create database: `dispatch`
3. Create container: `tasks` with partition key `/userId`
4. Go to **Keys** → note the **URI** and **Primary Key**

### 3. GitHub Models API Key (Free GPT-4o)

1. Go to [github.com/marketplace/models](https://github.com/marketplace/models)
2. Select **GPT-4o** → Get API Key → Generate a **GitHub Personal Access Token**
3. Note the token — this is your `OPENAI_API_KEY`

> **Why not Azure OpenAI?** Azure OpenAI requires a separate approval on Azure for Students subscriptions. GitHub Models provides free GPT-4o access through the same OpenAI SDK and routes through a Microsoft-ecosystem endpoint (`models.inference.ai.azure.com`).

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
    "OPENAI_API_KEY": "<your GitHub Models token>",
    "COSMOS_ENDPOINT": "<Cosmos DB URI from Azure Portal → Keys>",
    "COSMOS_KEY": "<Cosmos DB Primary Key>",
    "COSMOS_DATABASE": "dispatch",
    "COSMOS_CONTAINER": "tasks",
    "AZURE_TENANT_ID": "<from App Registration>",
    "AZURE_CLIENT_ID": "<from App Registration>",
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
REACT_APP_TENANT_ID=common
REACT_APP_API_URL=http://localhost:7071/api
HTTPS=true
```

> `REACT_APP_TENANT_ID` must be `common` — not your actual tenant ID — to support personal Microsoft accounts alongside organisational accounts.

### 4. Start the backend

```bash
cd backend
func start
```

All 7 routes should appear in the terminal:
```
GET  http://localhost:7071/api/get-events
GET  http://localhost:7071/api/get-inbox
GET  http://localhost:7071/api/pre-meeting-brief
POST http://localhost:7071/api/post-meeting-process
GET  http://localhost:7071/api/thread-catchup
GET  http://localhost:7071/api/daily-todos
POST http://localhost:7071/api/approve-item
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

```
az login
```

A browser window opens → sign in with `admin@YOURNAME.onmicrosoft.com` → close the window → your terminal will confirm you're logged in.

---

## Set Environment Variables on the Function App

Run this entire block (replace all the YOUR_X values with your real values — same ones from local.settings.json):

```
az functionapp config appsettings set \
  --name dispatch-api-YOURNAME \
  --resource-group dispatch-rg \
  --settings \
  "AZURE_OPENAI_ENDPOINT=https://dispatch-openai.openai.azure.com/" \
  "AZURE_OPENAI_API_KEY=your_actual_key" \
  "AZURE_OPENAI_DEPLOYMENT=gpt-4o" \
  "COSMOS_ENDPOINT=https://dispatch-cosmos-yourname.documents.azure.com:443/" \
  "COSMOS_KEY=your_actual_cosmos_key" \
  "COSMOS_DATABASE=dispatch" \
  "COSMOS_CONTAINER=tasks" \
  "AZURE_TENANT_ID=your_tenant_id" \
  "AZURE_CLIENT_ID=your_client_id" \
  "ALLOWED_ORIGINS=*"
```

---

## Deploy the Backend

```
cd dispatch/backend
func azure functionapp publish dispatch-api-YOURNAME
```

Takes ~2 minutes. At the end you'll see:
```
Functions in dispatch-api-YOURNAME:
    preMeetingBrief - [httpTrigger]
    postMeetingProcess - [httpTrigger]
    ...
```

Your API is now live at: `https://dispatch-api-YOURNAME.azurewebsites.net/api`

---

## Create the Static Web App for the Frontend

```
az staticwebapp create \
  --name dispatch-frontend \
  --resource-group dispatch-rg \
  --location eastus2
```

---

## Update Frontend .env for Production

Open `dispatch/frontend/.env` and change the API URL:

```
REACT_APP_CLIENT_ID=your_client_id
REACT_APP_TENANT_ID=your_tenant_id
REACT_APP_API_URL=https://dispatch-api-YOURNAME.azurewebsites.net/api
```

---

## Build and Deploy the Frontend

```
cd dispatch/frontend
npm run build
```

Wait ~1 minute for the build to complete. Then:

```
npm install -g @azure/static-web-apps-cli
swa login
```

Another browser window for auth. Then:

```
swa deploy ./build --deployment-token $(az staticwebapp secrets list --name dispatch-frontend --resource-group dispatch-rg --query "properties.apiKey" --output tsv)
```

Or simpler — get the deployment token from the portal:
1. Azure Portal → Static Web Apps → dispatch-frontend
2. Left sidebar → **Manage deployment token**
3. Copy the token

Then:
```
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

```
az functionapp cors add \
  --name dispatch-api-YOURNAME \
  --resource-group dispatch-rg \
  --allowed-origins "https://your-app-name.azurestaticapps.net"
```

---

## Done. Your app is live.

Test the production URL in your browser — same flow as local testing.

---

## Microsoft Teams Sideloading

Run Dispatch inside Microsoft Teams as a personal app (no deployment needed for local demo).

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
Compress-Archive -Path manifest.json, icon-color.png, icon-outline.png -DestinationPath dispatch-manifest.zip
# On Mac/Linux:
zip dispatch-manifest.zip manifest.json icon-color.png icon-outline.png
```

In Microsoft Teams → **Apps** → **Manage your apps** → **Upload a custom app** → select `dispatch-manifest.zip`.

Dispatch appears as a personal app with four tabs: Daily View, Pre-Call Brief, Post-Call, Thread Catch-Up.

---

## API Reference

All endpoints require `Authorization: Bearer <access_token>`. The token is the Microsoft Graph delegated token obtained via MSAL.

| Method | Route | Description |
|---|---|---|
| GET | `/api/get-events` | Calendar events for the next 7 days |
| GET | `/api/get-inbox` | Recent inbox messages |
| GET | `/api/pre-meeting-brief?eventId=` | AI pre-call brief for a specific event |
| POST | `/api/post-meeting-process` | Process transcript → action items + drafts |
| GET | `/api/thread-catchup?conversationId=` | 3-line email thread summary |
| GET | `/api/daily-todos` | AI-prioritised daily view |
| POST | `/api/approve-item` | Approve an item from the queue |

**POST /api/post-meeting-process body:**
```json
{
  "transcript": "Full meeting transcript text...",
  "eventId": "optional calendar event ID"
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

**"Dispatch proposes, humans decide"** — Every AI output (tasks, email drafts, calendar invites) goes into an approval queue before any action is taken in Microsoft 365. Nothing executes without explicit user approval.

**Personal account compatibility** — Microsoft Graph personal accounts (`live.com`, `outlook.com`) reject many `$filter` query operators that work for organisational accounts. Dispatch fetches emails without server-side filters and filters client-side. Auth authority is set to `/common` rather than a tenant-specific URL.

**Single past meeting, not multiple** — The pre-call brief surfaces only the single most relevant past meeting (highest score by attendee overlap and keyword match). Multiple past meetings created noise. One clearly attributed meeting is more useful than three vaguely relevant ones.

**Cosmos DB serverless in Korea Central** — Azure for Students restricts available regions. Supported regions for this subscription: `koreacentral`, `eastasia`, `malaysiawest`, `uaenorth`, `austriaeast`.

---

## Environment Variables Reference

### Backend (`local.settings.json` → `Values`)

| Variable | Where to get it |
|---|---|
| `OPENAI_API_KEY` | github.com/marketplace/models → Get API key |
| `COSMOS_ENDPOINT` | Azure Portal → Cosmos DB → Keys → URI |
| `COSMOS_KEY` | Azure Portal → Cosmos DB → Keys → Primary Key |
| `COSMOS_DATABASE` | `dispatch` (default) |
| `COSMOS_CONTAINER` | `tasks` (default) |
| `AZURE_TENANT_ID` | Azure Portal → App Registration → Overview |
| `AZURE_CLIENT_ID` | Azure Portal → App Registration → Overview |
| `ALLOWED_ORIGINS` | `http://localhost:3000` for local dev |

### Frontend (`.env`)

| Variable | Value |
|---|---|
| `REACT_APP_CLIENT_ID` | App Registration client ID |
| `REACT_APP_TENANT_ID` | `common` (not your tenant ID) |
| `REACT_APP_API_URL` | `http://localhost:7071/api` |
| `HTTPS` | `true` (required for Teams sideloading) |


---

## Team

**Icebreakers — IIT Madras**  
Contact: da25s009@smail.iitm.ac.in  

Built for Microsoft AI Unlocked Phase 2, March 2026.
