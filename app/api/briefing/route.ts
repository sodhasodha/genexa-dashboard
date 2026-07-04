import { NextRequest, NextResponse } from 'next/server'
import { Anthropic } from '@anthropic-ai/sdk'

const client = new Anthropic()

export async function POST(request: NextRequest) {
  try {
    const { context } = await request.json()

    const systemPrompt = `You are my Chief Operating Officer. You MUST ONLY use verified facts from connected systems:
* Slack (messages, not inferred sentiment)
* Fathom (actual call transcripts + summaries)
* Mercury (actual balance changes over time)
* Monday.com (actual client status fields)
* Google Drive (file existence only, not importance)

Every morning, give me a sharp, no-fluff COO-style briefing covering:
1. What happened yesterday (verifiable facts only from the above systems)
2. What's on today's calendar and what I need to prepare
3. Financial snapshot (Mercury balance, today's transactions, outstanding payments)
4. Critical tasks and blockers
5. Client health flags (churn risk, overdue payments, ad issues)
6. One clear priority recommendation for the day

Format as bullet points under each section. Never invent data. If a system has no data, say so explicitly.`

    const contextSummary = `
## System Context

### Mercury
Balance: $${context.balance || 0}
Recent Transactions: ${context.transactions?.length || 0} in last 7 days

### Calendar
Today's Events: ${context.calendar?.length || 0} events
Next 24h: ${context.calendar?.slice(0, 3).map((e: any) => e.summary).join(', ') || 'No events'}

### Meetings
Last 7 days: ${context.meetings?.length || 0} meetings

### Tasks
Today: ${context.tasks?.filter((t: any) => t.col === 'today').length || 0} tasks
This Week: ${context.tasks?.filter((t: any) => t.col === 'week').length || 0} tasks

### Clients
Active: ${context.clients?.length || 0}
Outstanding Payments: $${context.clients?.reduce((sum: number, c: any) => sum + (c.outstanding || 0), 0) || 0}
`

    // Use async streaming
    const response = new ReadableStream({
      async start(controller) {
        try {
          const stream = await client.messages.stream({
            model: 'claude-sonnet-5',
            max_tokens: 1000,
            system: systemPrompt,
            messages: [
              {
                role: 'user',
                content: `Please provide my morning briefing based on this context:\n${contextSummary}`,
              },
            ],
          })

          stream.on('text', (text) => {
            controller.enqueue(new TextEncoder().encode(text))
          })

          stream.on('end', () => {
            controller.close()
          })

          stream.on('error', (error) => {
            console.error('Stream error:', error)
            controller.error(error)
          })
        } catch (error) {
          console.error('Briefing error:', error)
          controller.error(error)
        }
      },
    })

    return new NextResponse(response, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  } catch (error) {
    console.error('Briefing route error:', error)
    return NextResponse.json(
      { error: 'Failed to generate briefing' },
      { status: 500 }
    )
  }
}
