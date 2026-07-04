'use client'

import { useState, useEffect, Fragment } from 'react'
import NavBar from '@/components/NavBar'
import Modal, { Field } from '@/components/Modal'
import { getClients, setClients, getRelationships } from '@/lib/storage'
import { CRMClient, Relationship } from '@/lib/types'

const VERTICALS = ['All', 'Genexa', 'Consulting', 'Groundwork', 'Toolbox', 'Other']
const CLIENT_VERTICALS: CRMClient['vertical'][] = ['Genexa', 'Consulting', 'Groundwork', 'Toolbox', 'Other']
const PAYMENT_TYPES: CRMClient['paymentType'][] = ['Payment Plan', 'Recurring', 'Paid in Full']
const CHURN_RISKS: CRMClient['churnRisk'][] = ['Low', 'Medium', 'High']
const AD_STATUSES: CRMClient['adStatus'][] = ['Active', 'Payment Error', 'Inactive', 'N/A']
const AD_HEALTHS: NonNullable<CRMClient['adHealth']>[] = ['Great', 'Working on it', 'Poor', 'N/A']

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

  // --- Add / Edit client modal ---
  const emptyClient = (): CRMClient => ({
    id: '',
    name: '',
    company: '',
    vertical: 'Genexa',
    paymentType: 'Recurring',
    amount: null,
    termDays: 30,
    outstanding: 0,
    nextPaymentDue: '',
    nextContact: '',
    churnRisk: 'Low',
    adStatus: 'Active',
    adHealth: 'Great',
    nextAction: '',
    notes: '',
  })
  const [clientModalOpen, setClientModalOpen] = useState(false)
  const [cDraft, setCDraft] = useState<CRMClient>(emptyClient())
  const [cEditing, setCEditing] = useState(false)

  const openAddClient = () => {
    setCDraft({ ...emptyClient(), id: `client-${Date.now()}` })
    setCEditing(false)
    setClientModalOpen(true)
  }
  const openEditClient = (c: CRMClient) => {
    setCDraft({ ...c })
    setCEditing(true)
    setClientModalOpen(true)
  }
  const saveClient = async () => {
    if (!cDraft.name.trim()) return
    const exists = clients.some((c) => c.id === cDraft.id)
    const updated = exists ? clients.map((c) => (c.id === cDraft.id ? cDraft : c)) : [...clients, cDraft]
    setClientsState(updated)
    setClientModalOpen(false)
    await setClients(updated)
  }
  const deleteClient = async (id: string) => {
    const updated = clients.filter((c) => c.id !== id)
    setClientsState(updated)
    setClientModalOpen(false)
    setExpandedClientId(null)
    await setClients(updated)
  }

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
          <button onClick={openAddClient} className="los-btn los-btn-primary">
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
                  <Fragment key={client.id}>
                    <tr
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
                    {expandedClientId === client.id && (
                      <tr className="bg-los-surface-2 border-b border-los-border">
                        <td colSpan={6} className="px-6 py-5">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            {[
                              ['Company', client.company || '—'],
                              ['Payment Type', client.paymentType],
                              ['MRR', mrrFor(client) ? `$${(mrrFor(client) / 1000).toFixed(1)}k` : '—'],
                              ['Term', client.termDays ? `${client.termDays} days` : '—'],
                              ['Ad Health', client.adHealth || '—'],
                              ['Next Payment', client.nextPaymentDue || '—'],
                              ['Next Contact', client.nextContact || '—'],
                              ['Next Action', client.nextAction || '—'],
                            ].map(([label, value]) => (
                              <div key={label}>
                                <p className="los-label mb-1">{label}</p>
                                <p className="text-sm text-los-text">{value}</p>
                              </div>
                            ))}
                          </div>
                          {client.notes && (
                            <p className="mt-4 text-sm text-los-text-muted italic">{client.notes}</p>
                          )}
                          <div className="mt-4">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                openEditClient(client)
                              }}
                              className="los-btn los-btn-ghost"
                            >
                              Edit client
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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

      <Modal
        open={clientModalOpen}
        onClose={() => setClientModalOpen(false)}
        title={cEditing ? 'Edit Client' : 'Add Client'}
        maxWidth="max-w-2xl"
        footer={
          <>
            {cEditing && (
              <button
                onClick={() => deleteClient(cDraft.id)}
                className="los-btn los-btn-ghost text-los-red mr-auto"
              >
                Delete
              </button>
            )}
            <button onClick={() => setClientModalOpen(false)} className="los-btn los-btn-ghost">
              Cancel
            </button>
            <button onClick={saveClient} className="los-btn los-btn-primary">
              Save
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <input className="los-input" autoFocus value={cDraft.name} onChange={(e) => setCDraft({ ...cDraft, name: e.target.value })} />
          </Field>
          <Field label="Company">
            <input className="los-input" value={cDraft.company || ''} onChange={(e) => setCDraft({ ...cDraft, company: e.target.value })} />
          </Field>
          <Field label="Vertical">
            <select className="los-select" value={cDraft.vertical} onChange={(e) => setCDraft({ ...cDraft, vertical: e.target.value as CRMClient['vertical'] })}>
              {CLIENT_VERTICALS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Payment Type">
            <select className="los-select" value={cDraft.paymentType} onChange={(e) => setCDraft({ ...cDraft, paymentType: e.target.value as CRMClient['paymentType'] })}>
              {PAYMENT_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Amount ($)">
            <input type="number" className="los-input" value={cDraft.amount ?? ''} placeholder="—"
              onChange={(e) => setCDraft({ ...cDraft, amount: e.target.value === '' ? null : Number(e.target.value) })} />
          </Field>
          <Field label="Term (days)">
            <input type="number" className="los-input" value={cDraft.termDays ?? ''} placeholder="—"
              onChange={(e) => setCDraft({ ...cDraft, termDays: e.target.value === '' ? null : Number(e.target.value) })} />
          </Field>
          <Field label="Outstanding ($)">
            <input type="number" className="los-input" value={cDraft.outstanding}
              onChange={(e) => setCDraft({ ...cDraft, outstanding: Number(e.target.value) })} />
          </Field>
          <Field label="Churn Risk">
            <select className="los-select" value={cDraft.churnRisk} onChange={(e) => setCDraft({ ...cDraft, churnRisk: e.target.value as CRMClient['churnRisk'] })}>
              {CHURN_RISKS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Ad Status">
            <select className="los-select" value={cDraft.adStatus} onChange={(e) => setCDraft({ ...cDraft, adStatus: e.target.value as CRMClient['adStatus'] })}>
              {AD_STATUSES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Ad Health">
            <select className="los-select" value={cDraft.adHealth || 'N/A'} onChange={(e) => setCDraft({ ...cDraft, adHealth: e.target.value as NonNullable<CRMClient['adHealth']> })}>
              {AD_HEALTHS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Next Payment Due">
            <input type="date" className="los-input" value={cDraft.nextPaymentDue || ''} onChange={(e) => setCDraft({ ...cDraft, nextPaymentDue: e.target.value })} />
          </Field>
          <Field label="Next Contact">
            <input type="date" className="los-input" value={cDraft.nextContact || ''} onChange={(e) => setCDraft({ ...cDraft, nextContact: e.target.value })} />
          </Field>
        </div>
        <Field label="Next Action">
          <input className="los-input" value={cDraft.nextAction} onChange={(e) => setCDraft({ ...cDraft, nextAction: e.target.value })} />
        </Field>
        <Field label="Notes">
          <textarea className="los-textarea" value={cDraft.notes} onChange={(e) => setCDraft({ ...cDraft, notes: e.target.value })} />
        </Field>
      </Modal>
    </div>
  )
}
