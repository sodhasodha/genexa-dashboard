# Life OS Dashboard

A personal operating system dashboard for Aryan Sodha built with Next.js 14, TypeScript, and Tailwind CSS.

## Features

- **Authentication**: Password-gated access with bcrypt hashing
- **Home Dashboard**: Real-time metrics, finance pulse, meetings brief, daily habits
- **Task Management**: Kanban board with Slack sync integration
- **Goals Tracking**: Revenue tracker with animated progress bars
- **CRM**: Client management with relationship tracking
- **Health Hub**: Dark mode health metrics and 7-day trends
- **Daily Logging**: Morning check-ins and EOD logs
- **Daily Briefing**: AI-powered COO briefing via Claude API
- **Calendar Integration**: Google Calendar with event notes
- **API Integration**: Mercury, Fathom, Monday.com, Slack, Claude

## Quick Start

```bash
# Install dependencies
npm install

# Create .env.local from .env.example
cp .env.example .env.local

# Generate password hash (run once)
node -e "const bcrypt = require('bcryptjs'); bcrypt.genSalt(10, (err, salt) => { bcrypt.hash('your-password', salt, (err, hash) => { console.log(hash); }); });"

# Update DASHBOARD_PASSWORD_HASH in .env.local with the generated hash

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

## Environment Variables

See `.env.example` for all required variables:
- `DASHBOARD_PASSWORD_HASH` - Bcrypt hash of dashboard password
- `MERCURY_API_KEY` - Mercury banking API key
- `GOOGLE_*` - Google Calendar credentials
- `FATHOM_API_KEY` - Fathom meeting recording API key
- `MONDAY_API_KEY` - Monday.com board API key
- `SLACK_BOT_TOKEN` - Slack bot token
- `SLACK_USER_ID` - Aryan's Slack user ID
- `ANTHROPIC_API_KEY` - Claude AI API key

## Project Structure

```
app/
├── api/                    # API routes (server-side)
│   ├── auth/login/
│   ├── mercury/
│   ├── calendar/
│   ├── meetings/
│   ├── team-pulse/
│   ├── slack/
│   └── briefing/
├── home/                   # Home dashboard
├── tasks/                  # Kanban board
├── goals/                  # Revenue tracker
├── clients/                # CRM + relationships
├── health/                 # Health hub (dark mode)
├── docs/                   # Document links
├── login/                  # Password gate
├── layout.tsx
├── page.tsx
└── globals.css
lib/
├── auth.ts                 # Authentication utilities
├── storage.ts              # localStorage utilities
└── types.ts                # TypeScript interfaces
middleware.ts              # Auth middleware
```

## Data Persistence

All user data is stored in browser localStorage:
- Tasks, Goals, Docs, Clients, Relationships
- Daily logs and habits
- Calendar event notes
- Slack sync state

External data (Mercury, Calendar, Fathom, Monday) is fetched fresh on each load.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS 3
- **Auth**: bcryptjs + httpOnly cookies
- **State**: React hooks + localStorage
- **Fonts**: Inter (UI) + JetBrains Mono (numbers/code)
- **APIs**: Mercury, Google Calendar, Fathom, Monday.com, Slack, Claude

## Deployment

Designed for Node.js on a VPS with static IP (required by Mercury API).

```bash
npm run build
npm start
```

Configure Nginx reverse proxy and certbot for HTTPS.

## License

Private — For Aryan Sodha only
