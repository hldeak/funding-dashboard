import { NextRequest, NextResponse } from 'next/server'

const API_URL = process.env.API_URL || 'https://hldesk-funding-api.fly.dev'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params
  try {
    const res = await fetch(`${API_URL}/api/ai/traders/${name}`, { next: { revalidate: 30 } })
    const data = await res.json()
    return NextResponse.json(data)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to fetch' }, { status: 500 })
  }
}
