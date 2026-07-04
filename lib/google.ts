import { google } from 'googleapis'

// Server-side Google auth. A single OAuth2 client is configured with the
// long-lived refresh token; googleapis exchanges it for short-lived access
// tokens (and auto-refreshes them) on each request.
function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google credentials not configured')
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret)
  oauth2Client.setCredentials({ refresh_token: refreshToken })
  return oauth2Client
}

export function isGoogleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN
  )
}

export function getGmailClient() {
  return google.gmail({ version: 'v1', auth: getOAuth2Client() })
}

export function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: getOAuth2Client() })
}

export function getDriveClient() {
  return google.drive({ version: 'v3', auth: getOAuth2Client() })
}
