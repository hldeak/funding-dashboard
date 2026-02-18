import FundingTable from '@/components/FundingTable'
import Link from 'next/link'

export default function Home() {
  return (
    <main className="max-w-7xl mx-auto px-4 py-8">
      <FundingTable />
      <div className="mt-8 text-center">
        <Link href="/paper" className="text-blue-400 hover:text-blue-300 text-sm">
          📊 Paper Trading Dashboard →
        </Link>
      </div>
    </main>
  )
}
