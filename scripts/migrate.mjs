// Runs the DB migration by calling the app's /api/migrate endpoint.
// The app (dev or deployed) must be running with POSTGRES_URL configured.
//
//   node scripts/migrate.mjs                 # hits http://localhost:3000
//   BASE_URL=https://your-app.vercel.app node scripts/migrate.mjs
//
// Equivalent to:  curl -X POST <BASE_URL>/api/migrate

const base = process.env.BASE_URL || 'http://localhost:3000'

try {
  const res = await fetch(`${base}/api/migrate`, { method: 'POST' })
  const body = await res.json()
  if (!res.ok || !body.ok) {
    console.error('Migration failed:', body.error || res.statusText)
    process.exit(1)
  }
  console.log('Migration complete:', body)
} catch (err) {
  console.error(`Could not reach ${base}/api/migrate —`, err.message)
  console.error('Is the app running with POSTGRES_URL set?')
  process.exit(1)
}
