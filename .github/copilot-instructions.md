# Life OS Dashboard — Development Guide

## Setup

1. **Clone and install dependencies**
   ```bash
   npm install
   ```

2. **Generate password hash** (required once)
   ```bash
   node -e "const bcrypt = require('bcryptjs'); bcrypt.genSalt(10, (err, salt) => { bcrypt.hash('your-secure-password', salt, (err, hash) => { console.log(hash); }); });"
   ```

3. **Create .env.local** from .env.example
   ```bash
   cp .env.example .env.local
   ```

4. **Add generated hash to .env.local**
   ```
   DASHBOARD_PASSWORD_HASH="<paste bcrypt hash from step 2>"
   ```

5. **Add API credentials** (optional for full feature testing)
   - `MERCURY_API_KEY` — Get from Mercury dashboard
   - `GOOGLE_*` — Google Calendar OAuth credentials
   - `FATHOM_API_KEY` — Fathom meeting API
   - `MONDAY_API_KEY` — Monday.com API
   - `SLACK_BOT_TOKEN` — Slack bot token
   - `SLACK_USER_ID` — Your Slack user ID
   - `ANTHROPIC_API_KEY` — Claude AI API key

## Development

```bash
npm run dev
```

Open [http://localhost:3000/login](http://localhost:3000/login) and enter your password.

## Architecture

- **Auth**: Password-gated via middleware + httpOnly cookie (bcrypt)
- **Pages**: 6 main routes (Home, Tasks, Goals, Clients, Health, Docs)
- **API Routes**: Server-side integrations (Mercury, Calendar, Fathom, Monday, Slack, Claude)
- **State**: React hooks + localStorage for persistence
- **Styling**: Tailwind CSS with design system colors defined in config

## Key Features

1. **Home Dashboard** — Metrics + Finance Pulse + Meeting Brief + Daily Habits
2. **Tasks** — Kanban board with Slack sync
3. **Goals** — Revenue tracker with animated progress bars
4. **Clients** — CRM table with relationship tracking
5. **Health** — Dark mode hub with rings + 7-day trends
6. **Docs** — Grid of document links with tag filtering

## Build & Deploy

```bash
npm run build
npm start
```

For VPS deployment with PM2:
```bash
pm2 start npm --name "life-os" -- start
```

## Environment Variables

See `.env.example` for complete list. Required at minimum:
- `DASHBOARD_PASSWORD_HASH` — Password to access dashboard
- `ANTHROPIC_API_KEY` — For briefing generation (optional)

## TypeScript

Strict mode disabled for faster iteration. Enable in `tsconfig.json` if needed.

## Notes

- All user data stored in browser localStorage
- External data (Mercury, Calendar) fetched fresh on load
- No database required
- Static IP required for Mercury API whitelist
