'use client'

import { useState, useEffect, Fragment } from 'react'
import Modal, { Field } from '@/components/Modal'
import { getClients, setClients, getRelationships, setRelationships } from '@/lib/storage'
import { CRMClient, Relationship } from '@/lib/types'

const VERTICALS = ['All', 'Genexa', 'Consulting', 'Groundwork', 'Toolbox', 'Other']
const CLIENT_VERTICALS: CRMClient['vertical'][] = ['Genexa', 'Consulting', 'Groundwork', 'Toolbox', 'Other']
const PAYMENT_TYPES: CRMClient['paymentType'][] = ['Payment Plan', 'Recurring', 'Paid in Full']
const CHURN_RISKS: CRMClient['churnRisk'][] = ['Low', 'Medium', 'High']
const AD_STATUSES: CRMClient['adStatus'][] = ['Active', 'Payment Error', 'Inactive', 'N/A']
const AD_HEALTHS: NonNullable<CRMClient['adHealth']>[] = ['Great', 'Working on it', 'Poor', 'N/A']
const REL_ROLES = ['Mentor', 'Employee', 'Investor', 'Partner', 'Other']
const REL_CHANNELS = ['Slack', 'WhatsApp', 'Email', 'Phone', 'In Person']

// MRR per client = amount / (termDays / 30). Clients with null amount are excluded.
const mrrFor = (c: CRMClient) => (c.amount && c.termDays ? c.amount / (c.termDays / 30) : 0)

type SortKey = 'name' | 'vertical' | 'amount' | 'outstanding' | 'churnRisk' | 'adStatus'

export default function ClientsPage() {
  const [clients, setClientsState] = useState<CRMClient[]>([])
  const [relationships, setRelationshipsState] = useState<Relationship[]>([])
  const [selectedVertical, setSelectedVertical] = useState('All')
  const [expandedClientId, setExpandedClientId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

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

  // Best-effort: match clients to Whop memberships (by name token appearing in
  // the member email) and sync their next-payment date from the renewal date.
  const [whopStatus, setWhopStatus] = useState('')
  const syncWhop = async () => {
    setWhopStatus('Syncing…')
    try {
      const { renewals } = await fetch('/api/whop/renewals').then((r) => r.json())
      if (!Array.isArray(renewals)) return setWhopStatus('No Whop data')
      let matched = 0
      const updated = clients.map((c) => {
        const tokens = `${c.name} ${c.company || ''}`
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length >= 4 && !['and', 'the', 'dr'].includes(t))
        const hit = renewals.find((r: any) => tokens.some((t) => r.email.toLowerCase().includes(t)))
        if (hit) {
          matched++
          return { ...c, nextPaymentDue: hit.renewalDate }
        }
        return c
      })
      if (matched > 0) {
        setClientsState(updated)
        await setClients(updated)
      }
      setWhopStatus(matched > 0 ? `Synced ${matched} from Whop` : 'No client↔Whop matches')
    } catch {
      setWhopStatus('Whop sync failed')
    }
  }

  // --- Relationship add / edit modal ---
  const emptyRel = (): Relationship => ({
    id: '',
    name: '',
    role: 'Mentor',
    channel: 'Slack',
    whyContact: '',
    freqDays: 30,
    lastContacted: new Date().toISOString().slice(0, 10),
    notes: '',
  })
  const [relModalOpen, setRelModalOpen] = useState(false)
  const [rDraft, setRDraft] = useState<Relationship>(emptyRel())
  const [rEditing, setREditing] = useState(false)
  const openAddRel = () => {
    setRDraft({ ...emptyRel(), id: `rel-${Date.now()}` })
    setREditing(false)
    setRelModalOpen(true)
  }
  const openEditRel = (r: Relationship) => {
    setRDraft({ ...r })
    setREditing(true)
    setRelModalOpen(true)
  }
  const saveRel = async () => {
    if (!rDraft.name.trim()) return
    const exists = relationships.some((r) => r.id === rDraft.id)
    const updated = exists ? relationships.map((r) => (r.id === rDraft.id ? rDraft : r)) : [...relationships, rDraft]
    setRelationshipsState(updated)
    setRelModalOpen(false)
    await setRelationships(updated)
  }
  const deleteRel = async (id: string) => {
    const updated = relationships.filter((r) => r.id !== id)
    setRelationshipsState(updated)
    setRelModalOpen(false)
    await setRelationships(updated)
  }

  const filteredClients = selectedVertical === 'All'
    ? clients
    : clients.filter((c) => c.vertical === selectedVertical)

  const sortedClients = [...filteredClients].sort((a, b) => {
    let av: any = a[sortKey]
    let bv: any = b[sortKey]
    if (sortKey === 'churnRisk') {
      const order = { Low: 0, Medium: 1, High: 2 } as Record<string, number>
      av = order[a.churnRisk]
      bv = order[b.churnRisk]
    }
    if (av == null) av = sortKey === 'amount' ? -1 : ''
    if (bv == null) bv = sortKey === 'amount' ? -1 : ''
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
    return sortDir === 'asc' ? cmp : -cmp
  })

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

  if (loading) return <div className="p-8 text-los-text-muted">Loading…</div>

  const SortTh = ({ label, k, right }: { label: string; k: SortKey; right?: boolean }) => (
    <th
      onClick={() => toggleSort(k)}
      className={`px-4 py-2.5 los-label cursor-pointer select-none hover:text-los-text-secondary ${right ? 'text-right' : 'text-left'}`}
    >
      {label}
      <span className="text-los-accent ml-1">{sortKey === k ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span>
    </th>
  )

  return (
    <div className="px-6 py-5 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-los-text tracking-tight">Clients</h1>
          {whopStatus && <span className="text-xs text-los-text-muted">{whopStatus}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={syncWhop} className="los-btn los-btn-ghost">⟳ Sync Whop</button>
          <button onClick={openAddClient} className="los-btn los-btn-primary">+ Add Contact</button>
        </div>
      </div>

      {/* Summary Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="los-card p-4">
          <p className="los-label mb-1">Total MRR</p>
          <p className="los-metric-number">${(totalMRR / 1000).toFixed(1)}k</p>
        </div>
        <div className="los-card p-4">
          <p className="los-label mb-1">Outstanding</p>
          <p className="los-metric-number text-los-red">${(totalOutstanding / 1000).toFixed(1)}k</p>
        </div>
        <div className="los-card p-4">
          <p className="los-label mb-1">Active (Ad)</p>
          <p className="los-metric-number">{clients.filter((c) => c.adStatus === 'Active').length}</p>
        </div>
        <div className="los-card p-4">
          <p className="los-label mb-1">90-Day Forecast</p>
          <p className="los-metric-number text-los-green">${(forecast90 / 1000).toFixed(1)}k</p>
        </div>
      </div>

      {/* Vertical Filter */}
      <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1">
        {VERTICALS.map((vertical) => (
          <button
            key={vertical}
            onClick={() => setSelectedVertical(vertical)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition ${
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
          <table className="w-full text-[13px]">
            <thead className="border-b border-los-border bg-los-surface-2">
              <tr>
                <SortTh label="Name" k="name" />
                <SortTh label="Vertical" k="vertical" />
                <SortTh label="Amount" k="amount" />
                <SortTh label="Outstanding" k="outstanding" />
                <SortTh label="Churn Risk" k="churnRisk" />
                <SortTh label="Ad Status" k="adStatus" />
              </tr>
            </thead>
            <tbody>
              {sortedClients.map((client) => (
                  <Fragment key={client.id}>
                    <tr
                      onClick={() =>
                        setExpandedClientId(expandedClientId === client.id ? null : client.id)
                      }
                      className="border-b border-los-border hover:bg-los-surface-2 cursor-pointer transition"
                    >
                      <td className="px-4 py-2.5 font-medium text-los-text">{client.name}</td>
                      <td className="px-4 py-2.5 text-los-text-muted text-xs">{client.vertical}</td>
                      <td className="px-4 py-2.5 font-mono text-los-text">
                        {client.amount == null ? '—' : `$${(client.amount / 1000).toFixed(1)}k`}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-los-red">
                        ${(client.outstanding / 1000).toFixed(1)}k
                      </td>
                      <td className={`px-4 py-2.5 font-medium ${getChurnRiskColor(client.churnRisk)}`}>
                        {client.churnRisk}
                      </td>
                      <td className={`px-4 py-2.5 text-xs font-medium ${
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
                        <td colSpan={6} className="px-4 py-4">
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
      <div className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-los-text">Relationships</h2>
          <button onClick={openAddRel} className="los-btn los-btn-ghost text-xs">+ Add</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {relationships.map((rel) => {
            const daysSince = Math.floor((Date.now() - new Date(rel.lastContacted).getTime()) / 86400000)
            const daysUntil = rel.freqDays - daysSince
            const isOverdue = daysUntil < 0
            return (
              <button
                key={rel.id}
                onClick={() => openEditRel(rel)}
                className={`los-card p-3.5 text-left hover:border-los-border-hover transition ${isOverdue ? 'ring-1 ring-los-red' : ''}`}
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-semibold text-los-text text-sm">{rel.name}</h3>
                  <span className="text-[10px] bg-los-surface-2 text-los-text-muted px-2 py-0.5 rounded">{rel.role}</span>
                </div>
                <div className="text-xs text-los-text-muted space-y-1">
                  <p>{rel.channel} · every {rel.freqDays}d</p>
                  <p>
                    Next contact:{' '}
                    <span className={isOverdue ? 'text-los-red font-semibold' : 'text-los-text-secondary'}>
                      {isOverdue ? 'Overdue' : `${Math.max(daysUntil, 0)} days`}
                    </span>
                  </p>
                </div>
              </button>
            )
          })}
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

      <Modal
        open={relModalOpen}
        onClose={() => setRelModalOpen(false)}
        title={rEditing ? 'Edit Relationship' : 'Add Relationship'}
        footer={
          <>
            {rEditing && (
              <button onClick={() => deleteRel(rDraft.id)} className="los-btn los-btn-ghost text-los-red mr-auto">Delete</button>
            )}
            <button onClick={() => setRelModalOpen(false)} className="los-btn los-btn-ghost">Cancel</button>
            <button onClick={saveRel} className="los-btn los-btn-primary">Save</button>
          </>
        }
      >
        <Field label="Name">
          <input className="los-input" autoFocus value={rDraft.name} onChange={(e) => setRDraft({ ...rDraft, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Role">
            <select className="los-select" value={rDraft.role} onChange={(e) => setRDraft({ ...rDraft, role: e.target.value })}>
              {REL_ROLES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Channel">
            <select className="los-select" value={rDraft.channel} onChange={(e) => setRDraft({ ...rDraft, channel: e.target.value })}>
              {REL_CHANNELS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Contact every (days)">
            <input type="number" className="los-input" value={rDraft.freqDays} onChange={(e) => setRDraft({ ...rDraft, freqDays: Number(e.target.value) })} />
          </Field>
          <Field label="Last contacted">
            <input type="date" className="los-input" value={rDraft.lastContacted} onChange={(e) => setRDraft({ ...rDraft, lastContacted: e.target.value })} />
          </Field>
        </div>
        <Field label="Why contact">
          <input className="los-input" value={rDraft.whyContact} onChange={(e) => setRDraft({ ...rDraft, whyContact: e.target.value })} />
        </Field>
        <Field label="Notes">
          <textarea className="los-textarea" value={rDraft.notes} onChange={(e) => setRDraft({ ...rDraft, notes: e.target.value })} />
        </Field>
      </Modal>
    </div>
  )
}
