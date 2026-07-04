import { NextRequest, NextResponse } from 'next/server'
import { Anthropic } from '@anthropic-ai/sdk'

const client = new Anthropic()

export async function POST(request: NextRequest) {
  try {
    const { processedTs = [] } = await request.json()

    const botToken = process.env.SLACK_BOT_TOKEN
    const userId = process.env.SLACK_USER_ID
    const channelId = process.env.SLACK_CHANNEL_ID

    if (!botToken || !userId) {
      return NextResponse.json(
        { error: 'Slack credentials not configured' },
        { status: 500 }
      )
    }

    // A bot token (xoxb) can't call search.messages — that needs a user token.
    // Instead we read the history of a specific channel the bot belongs to
    // (channels:history scope) and keep only the target user's messages.
    if (!channelId) {
      return NextResponse.json(
        { error: 'Slack channel not configured (set SLACK_CHANNEL_ID)' },
        { status: 500 }
      )
    }

    const fortyEightHoursAgo = Math.floor(Date.now() / 1000) - 48 * 60 * 60

    const historyResponse = await fetch(
      `https://slack.com/api/conversations.history?channel=${encodeURIComponent(
        channelId
      )}&oldest=${fortyEightHoursAgo}&limit=100`,
      {
        headers: {
          Authorization: `Bearer ${botToken}`,
        },
      }
    )

    const historyData = await historyResponse.json()

    if (!historyData.ok) {
      throw new Error(`Slack API error: ${historyData.error}`)
    }

    // Keep only real messages from the target user that haven't been processed yet.
    // Skip system/join/bot messages (they carry a `subtype`) and empty text.
    const messages = (historyData.messages || [])
      .filter(
        (msg: any) =>
          msg.user === userId &&
          !msg.subtype &&
          msg.text &&
          !processedTs.includes(msg.ts)
      )
      .slice(0, 10)

    if (messages.length === 0) {
      return NextResponse.json({
        operations: [],
        newProcessedTs: [],
      })
    }

    // Parse messages with Claude
    const messageTexts = messages.map((msg: any) => msg.text).join('\n')

    const today = new Date().toISOString().split('T')[0]

    const completion = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: `You are a task parser for Aryan's Life OS Dashboard. Parse each Slack message and return a JSON array of task operations. Infer intent from natural language — add, complete, delete, or move tasks. Extract due dates if mentioned and convert to ISO format YYYY-MM-DD based on today's date (${today}). Examples: "by Friday", "due 15th June", "tomorrow", "next week" → compute the actual date. If intent is ambiguous, default to THIS_WEEK column with NORMAL priority. Track processed messages by Slack ts to avoid duplicates. Return only valid JSON: [{ "action": "add" | "complete" | "delete" | "move", "task": "task name", "column": "BACKLOG" | "THIS_WEEK" | "TODAY" | "WAITING_ON" | "DONE", "priority": "NORMAL" | "WARM" | "HOT", "due_date": "YYYY-MM-DD or null", "ts": "slack message timestamp" }]. Return empty array [] if nothing actionable.

Messages:
${messageTexts}`,
        },
      ],
    })

    // Sonnet 5 can emit a thinking block first, so find the text block by type
    // rather than assuming it's content[0].
    const textBlock = completion.content.find((b) => b.type === 'text') as
      | { type: 'text'; text: string }
      | undefined
    const responseText = textBlock?.text || '[]'

    // Parse JSON response
    let operations = []
    try {
      operations = JSON.parse(responseText)
    } catch (e) {
      console.error('Failed to parse Claude response:', responseText)
      operations = []
    }

    const newProcessedTs = messages.map((msg: any) => msg.ts)

    return NextResponse.json({
      operations,
      newProcessedTs,
    })
  } catch (error) {
    console.error('Slack sync error:', error)
    return NextResponse.json(
      { error: 'Failed to sync Slack tasks' },
      { status: 500 }
    )
  }
}
