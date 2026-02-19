import { NextRequest, NextResponse } from 'next/server'
const API_URL = process.env.API_URL || 'https://hldesk-funding-api.fly.dev'
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const res = await fetch(`${API_URL}/api/paper/portfolios/${params.id}`)
    return NextResponse.json(await res.json())
  } catch { return NextResponse.json({}, { status: 500 }) }
}
