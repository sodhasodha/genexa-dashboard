import { NextResponse } from 'next/server'

const MONDAY_API_URL = 'https://api.monday.com/v2'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const apiKey = process.env.MONDAY_API_KEY

    if (!apiKey) {
      return NextResponse.json(
        { error: 'Monday.com API key not configured' },
        { status: 500 }
      )
    }

    const query = `
      query {
        boards(limit: 10) {
          id
          name
          items_page(limit: 10) {
            items {
              id
              name
              board {
                name
              }
              column_values {
                id
                text
              }
            }
          }
        }
      }
    `

    const response = await fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    })

    if (!response.ok) {
      throw new Error(`Monday.com API error: ${response.statusText}`)
    }

    const data = await response.json()

    if (data.errors) {
      throw new Error(data.errors[0].message)
    }

    const items = data.data.boards
      .flatMap((board: any) =>
        board.items_page.items.map((item: any) => ({
          name: item.name,
          board: board.name,
          status: 'active',
        }))
      )
      .slice(0, 5)

    return NextResponse.json({
      items,
    })
  } catch (error) {
    console.error('Monday.com team pulse error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch Monday.com data' },
      { status: 500 }
    )
  }
}
