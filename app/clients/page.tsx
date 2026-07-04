'use client'

import { useState, useEffect } from 'react'
import NavBar from '@/components/NavBar'
import { getClients, getRelationships } from '@/lib/storage'
import { CRMClient, Relationship } from '@/lib/types'

const VERTICALS = ['All', 'Genexa', 'Consulting', 'Groundwork', 'Toolbox', 'Other']

// MRR per client = amount / (termDays / 30). Clients with null amount are excluded.
const mrrFor = (c: CRMClient) => (c.amount && c.termDays ? c.amount / (c.termDays / 30) : 0)

export default function ClientsPage() {
  const [clients, setClientsState] = useState<CRMClient[]>([])
  const [relationships, setRelationshipsState] = useState<Relationship[]>([])
  const [selectedVertical, setSelectedVertical] = useState('All')
  const [expandedClientId, setExpandedClientId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      const [loadedClients, loadedRelationships] = await Promise.all([
        getClients(),
        getRelationships(),
      ])
      setClientsState(loadedClients)
      setRelationshipsState(loadedRelationships)
      setLoading(false)
    })()
  }, [])

  const filteredClients = selectedVertical === 'All'
    ? clients
    : clients.filter((c) => c.vertical === selectedVertical)

  const totalMRR = filteredClients.reduce((sum, c) => sum + mrrFor(c), 0)
  const totalOutstanding = filteredClients.reduce((sum, c) => sum + (c.outstanding || 0), 0)
  // 90-day forecast assumes 30% MoM growth.
  const forecast90 = totalMRR + totalMRR * 1.3 + totalMRR * 1.3 * 1.3

  const getChurnRiskColor = (risk: string) => {
    switch (risk) {
      case 'Low':
        return 'text-los-green'
      case 'Medium':
        return 'text-los-amber animate-pulse'
      case 'High':
        return 'text-los-red animate-pulse'
      default:
        return 'text-los-text-muted'
    }
  }

  if (loading) return <div>Loading...</div>

  return (
    <div className="min-h-screen bg-los-bg">
      <NavBar />

      <div className="mt-60px p-6" style={{ marginTop: '60px' }}>
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-los-text">Clients</h1>
          <button className="px-4 py-2 bg-los-accent text-white rounded-lg hover:bg-blue-600">
            + Add Contact
          </button>
        </div>

        {/* Summary Bar */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="los-card p-4">
            <p className="los-label mb-1">Total MRR</p>
            <p className="los-metric-number text-los-text">${(totalMRR / 1000).toFixed(1)}k</p>
          </div>
          <div className="los-card p-4">
            <p className="los-label mb-1">Outstanding</p>
            <p className="los-metric-number text-los-red">${(totalOutstanding / 1000).toFixed(1)}k</p>
          </div>
          <div className="los-card p-4">
            <p className="los-label mb-1">Active Clients</p>
            <p className="los-metric-number text-los-text">{filteredClients.length}</p>
          </div>
          <div className="los-card p-4">
            <p className="los-label mb-1">90-Day Forecast</p>
            <p className="los-metric-number text-los-green text-base">
              ${(forecast90 / 1000).toFixed(1)}k
            </p>
          </div>
        </div>

        {/* Vertical Filter */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {VERTICALS.map((vertical) => (
            <button
              key={vertical}
              onClick={() => setSelectedVertical(vertical)}
              className={`px-4 py-2 rounded-full font-medium whitespace-nowrap transition ${
                selectedVertical === vertical
                  ? 'bg-los-accent text-white'
                  : 'bg-los-surface text-los-text-muted hover:bg-los-surface-2'
              }`}
            >
              {vertical}
            </button>
          ))}
        </div>

        {/* Clients Table */}
        <div className="los-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-los-border bg-los-surface-2">
                <tr>
                  <th className="px-6 py-3 text-left los-label">Name</th>
                  <th className="px-6 py-3 text-left los-label">Vertical</th>
                  <th className="px-6 py-3 text-left los-label">Amount</th>
                  <th className="px-6 py-3 text-left los-label">Outstanding</th>
                  <th className="px-6 py-3 text-left los-label">Churn Risk</th>
                  <th className="px-6 py-3 text-left los-label">Ad Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredClients.map((client) => (
                  <tr
                    key={client.id}
                    onClick={() =>
                      setExpandedClientId(expandedClientId === client.id ? null : client.id)
                    }
                    className="border-b border-los-border hover:bg-los-surface-2 cursor-pointer transition"
                  >
                    <td className="px-6 py-3 font-medium text-los-text">{client.name}</td>
                    <td className="px-6 py-3 text-los-text-muted text-xs">{client.vertical}</td>
                    <td className="px-6 py-3 font-mono text-los-text">
                      {client.amount == null ? '—' : `$${(client.amount / 1000).toFixed(1)}k`}
                    </td>
                    <td className="px-6 py-3 font-mono text-los-red">
                      ${(client.outstanding / 1000).toFixed(1)}k
                    </td>
                    <td className={`px-6 py-3 font-medium ${getChurnRiskColor(client.churnRisk)}`}>
                      {client.churnRisk}
                    </td>
                    <td className={`px-6 py-3 text-xs font-medium ${
                      client.adStatus === 'Active'
                        ? 'text-los-green'
                        : client.adStatus === 'Payment Error'
                          ? 'text-los-red animate-pulse'
                          : 'text-los-text-muted'
                    }`}>
                      {client.adStatus}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Relationships Section */}
        <div className="mt-8">
          <h2 className="text-xl font-bold text-los-text mb-4">Relationships</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {relationships.map((rel) => {
              const daysSinceContact = Math.floor(
                (Date.now() - new Date(rel.lastContacted).getTime()) / (1000 * 60 * 60 * 24)
              )
              const daysUntilNextContact = rel.freqDays - daysSinceContact
              const isOverdue = daysUntilNextContact < 0

              return (
                <div
                  key={rel.id}
                  className={`los-card p-4 ${isOverdue ? 'ring-2 ring-los-red' : ''}`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-semibold text-los-text">{rel.name}</h3>
                      <span className="text-xs bg-los-surface-2 text-los-text-muted px-2 py-1 rounded inline-block mt-1">
                        {rel.role}
                      </span>
                    </div>
                  </div>
                  <div className="text-xs text-los-text-muted space-y-1">
                    <p>📱 {rel.channel}</p>
                    <p>
                      Next contact:{' '}
                      <span className={isOverdue ? 'text-los-red font-semibold' : ''}>
                        {isOverdue ? 'Overdue!' : `${Math.max(daysUntilNextContact, 0)} days`}
                      </span>
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
