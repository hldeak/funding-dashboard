import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'HLDesk — Hyperliquid Funding Dashboard',
  description: 'Real-time funding rate spreads across Hyperliquid and major CEXs',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-gray-950">
        {children}
      </body>
    </html>
  )
}
