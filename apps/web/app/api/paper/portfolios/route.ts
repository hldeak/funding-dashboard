import { NextResponse } from 'next/server'
const API_URL = process.env.API_URL || 'https://hldesk-funding-api.fly.dev'
export async function GET() {
  try {
    const res = await fetch(`${API_URL}/api/paper/portfolios`, { next: { revalidate: 30 } })
    return NextResponse.json(await res.json())
  } catch { return NextResponse.json([], { status: 500 }) }
}
