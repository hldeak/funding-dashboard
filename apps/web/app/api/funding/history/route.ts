import { NextRequest, NextResponse } from 'next/server'

const API_URL = process.env.API_URL || 'https://hldesk-funding-api.fly.dev'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const params = searchParams.toString()
  
  try {
    const res = await fetch(`${API_URL}/api/funding/history?${params}`)
    const data = await res.json()
    return NextResponse.json(data)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to fetch' }, { status: 500 })
  }
}
