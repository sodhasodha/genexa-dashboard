# Life OS Dashboard — Quick Start Guide

## 🎉 Project Successfully Created!

The Life OS Dashboard has been scaffolded as a fully-functional Next.js 14 application with all core pages, authentication, and API route structure ready for development.

## 📋 What's Included

### ✅ Completed
- **Authentication System**: Password-gated access with bcrypt hashing and httpOnly cookies
- **6 Main Pages**: Home, Tasks, Goals, Clients, Health, Docs with full UI layouts
- **Navigation Bar**: Fixed header with time, streak counter, briefing button
- **Data Persistence**: localStorage utilities for all data types with pre-seeded clients/relationships
- **API Routes**: All 8 API routes stubbed and ready for integration (Mercury, Calendar, Fathom, Monday, Slack, Claude)
- **Styling**: Complete design system with Tailwind CSS and custom color palette
- **TypeScript**: Full type safety with all data interfaces defined

### 🚧 Ready to Implement
- Daily Log system (Morning Check-in / EOD Log modals)
- Task management with Slack sync
- Calendar integration with event notes
- API key integration for Mercury, Google Calendar, Fathom, Monday, Slack, Claude
- Inline editing for tasks, clients, goals, and docs

## 🚀 Getting Started

### 1. Install Dependencies (if not already done)
```bash
cd /Users/sodha/genexa-dashboard
npm install
```

### 2. Generate Password Hash
```bash
node -e "const bcrypt = require('bcryptjs'); bcrypt.genSalt(10, (err, salt) => { bcrypt.hash('your-secure-password', salt, (err, hash) => { console.log(hash); }); });"
```

Copy the output hash.

### 3. Create `.env.local`
```bash
cp .env.example .env.local
```

Edit `.env.local` and:
- Replace `DASHBOARD_PASSWORD_HASH` with the hash from step 2
- (Optional) Add API keys for Mercury, Google Calendar, Fathom, Monday, Slack, Claude

### 4. Start Development Server
```bash
npm run dev
```

Open [http://localhost:3000/login](http://localhost:3000/login) and login with your password.

## 📁 Project Structure

```
genexa-dashboard/
├── app/                          # Next.js App Router
│   ├── api/                      # API routes (server-side)
│   │   ├── auth/login/
│   │   ├── mercury/
│   │   ├── calendar/
│   │   ├── meetings/
│   │   ├── team-pulse/
│   │   ├── slack/
│   │   └── briefing/
│   ├── home/page.tsx             # Dashboard
│   ├── tasks/page.tsx            # Kanban board
│   ├── goals/page.tsx            # Revenue tracker
│   ├── clients/page.tsx          # CRM + relationships
│   ├── health/page.tsx           # Dark mode hub
│   ├── docs/page.tsx             # Document links
│   ├── login/page.tsx            # Password gate
│   ├── layout.tsx                # Root layout
│   ├── page.tsx                  # Redirect to /home
│   └── globals.css               # Global styles + animations
├── components/
│   ├── NavBar.tsx                # Fixed navigation
│   └── MetricCard.tsx            # Reusable metric card
├── lib/
│   ├── auth.ts                   # Password verification
│   ├── storage.ts                # localStorage utilities
│   └── types.ts                  # TypeScript interfaces
├── middleware.ts                 # Auth middleware
├── tailwind.config.ts            # Design system
├── next.config.mjs
├── tsconfig.json
├── package.json
├── .env.example
├── .github/copilot-instructions.md
├── IMPLEMENTATION_GUIDE.md
├── README.md
└── setup.sh                      # Setup automation script
```

## 🎯 Next Steps (Priority Order)

1. **Set up API keys** — Add them to `.env.local` for full feature testing
2. **Test all pages** — Verify navigation and layout on different screen sizes
3. **Implement Daily Log system** — Add Morning Check-in and EOD Log modals
4. **Connect Mercury API** — Test account balance and transaction fetching
5. **Implement Slack sync** — Test task parsing from Slack DMs
6. **Add modals** — Create/edit forms for tasks, goals, clients, docs
7. **Test Briefing** — Verify streaming Claude responses

See `IMPLEMENTATION_GUIDE.md` for detailed implementation checklist and best practices.

## 🔑 Environment Variables Required (Optional but Recommended)

```env
MERCURY_API_KEY=your_mercury_key          # Banking data
GOOGLE_CLIENT_ID=...                      # Calendar
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
FATHOM_API_KEY=...                        # Meeting summaries
MONDAY_API_KEY=...                        # Team tasks
SLACK_BOT_TOKEN=...                       # Task sync
SLACK_USER_ID=...
ANTHROPIC_API_KEY=...                     # AI briefing
```

## 💻 Available Commands

```bash
npm run dev      # Start development server (port 3000)
npm run build    # Production build
npm start        # Start production server
npm run lint     # Run linter
```

## 🎨 Design System

All colors are defined in `tailwind.config.ts`:
- `los-bg` — Warm cream background (#F3F2EE)
- `los-surface` — White cards (#FFFFFF)
- `los-accent` — Blue (#1D4ED8)
- `los-green` — Success (#16A34A)
- `los-red` — Error (#DC2626)
- `los-amber` — Warning (#D97706)

Typography:
- **UI**: Inter font (Google Fonts)
- **Numbers**: JetBrains Mono monospace

## 📊 Data Storage

| Data | Location | Persistence |
|------|----------|-------------|
| Tasks | `los_tasks` | ✓ localStorage |
| Goals | `los_goals` | ✓ localStorage |
| Clients | `los_crm_clients` | ✓ localStorage |
| Relationships | `los_relationships` | ✓ localStorage |
| Daily Logs | `los_log_YYYY-MM-DD` | ✓ localStorage |
| Calendar Notes | `cal-note-{eventId}` | ✓ localStorage |
| Mercury / Calendar / Fathom | API | ✗ Fresh on load |

## 🔐 Authentication

- Password stored as bcrypt hash in `DASHBOARD_PASSWORD_HASH` env var
- Auth token stored in httpOnly cookie (30-day expiration)
- Middleware protects all routes except `/login` and `/api/auth/login`
- No user database required — single shared password

## 🌐 Responsive Design

- Mobile-first Tailwind approach
- Navigation hides on small screens (add mobile drawer if needed)
- All pages scale from mobile (sm) to desktop (lg+)
- Touch-friendly controls with adequate spacing

## 🚀 Deployment

When ready to deploy:

```bash
npm run build
npm start
```

For VPS with PM2:
```bash
pm2 start npm --name "life-os" -- start
pm2 save
```

Configure Nginx reverse proxy and SSL with Certbot. Whitelist your VPS static IP in Mercury dashboard.

## 📚 Additional Resources

- **IMPLEMENTATION_GUIDE.md** — Detailed feature checklist and extension guide
- **README.md** — Full project documentation
- **.github/copilot-instructions.md** — Development setup reference
- **package.json** — Dependencies and scripts

## ❓ FAQ

**Q: Can I use a different password per user?**
A: Currently, it's a single shared password. To add multi-user support, you'd need a database and JWT tokens.

**Q: Do I need to deploy to a VPS?**
A: Recommended for Mercury API (requires static IP), but works on localhost for development.

**Q: Can I use this without API keys?**
A: Yes! All pages work with pre-seeded data. API endpoints will fail gracefully if keys aren't configured.

**Q: How do I backup my data?**
A: Data is in browser localStorage. Export via DevTools → Application → LocalStorage, or implement a backup API.

**Q: Can I extend with a database?**
A: Yes! Replace localStorage calls in `lib/storage.ts` with API calls to your database.

## 🎓 Learning Resources

- [Next.js 14 Documentation](https://nextjs.org/docs)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [React Hooks Guide](https://react.dev/reference/react/hooks)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

---

**Happy coding! 🚀**

Have questions? Check `IMPLEMENTATION_GUIDE.md` or the spec in `.github/copilot-instructions.md`.
