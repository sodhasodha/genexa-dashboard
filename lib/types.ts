export interface Task {
  id: string
  name: string
  col: 'backlog' | 'week' | 'today' | 'waiting' | 'done'
  priority: 'normal' | 'warm' | 'hot'
  starred: boolean
  due_date: string | null
  notes: string
  created: number
  doneAt?: number
}

export interface Goal {
  id: string
  name: string
  current: number
  target: number
  notes: string
}

export interface CRMClient {
  id: string
  name: string
  company?: string
  vertical: 'Genexa' | 'Consulting' | 'Groundwork' | 'Toolbox Growth'
  paymentType: 'Payment Plan' | 'Recurring' | 'Paid in Full'
  amount: number
  term?: number
  outstanding: number
  nextPaymentDue: string | null
  nextContactDate: string | null
  churnRisk: 'Low' | 'Medium' | 'High'
  adStatus: 'Active' | 'Payment Error' | 'Inactive'
  adHealth?: 'Great' | 'Good' | 'Fair' | 'Poor'
  nextAction: string
  notes: string
}

export interface Relationship {
  id: string
  name: string
  role: string
  channel: string
  whyContact: string
  freqDays: number
  lastContacted: string
  notes: string
}

export interface Doc {
  id: string
  name: string
  url: string
  tag: string
}

export interface DailyLog {
  date: string
  // Morning
  sleep?: number
  feeling?: number
  // EOD
  exerciseHours?: number
  caloriesBurned?: number
  stepsTaken?: number
  caloriesEaten?: number
  energy?: number
  winsToday?: string
  challenges?: string
  tomorrowsFocus?: string
}

export interface DailyHabits {
  date: string
  gym: boolean
  eatHealthy: boolean
  deepWork: boolean
  eodDone: boolean
}

export interface MercuryAccount {
  id: string
  kind: string
  availableBalance: number
  currentBalance: number
}

export interface MercuryTransaction {
  id: string
  amount: number
  bankDescription: string
  counterpartyName: string
  postedAt: string
  createdAt: string
  status: 'pending' | 'sent' | 'settled'
}

export interface CalendarEvent {
  id: string
  summary: string
  start: { dateTime: string }
  end: { dateTime: string }
  location?: string
  attendees?: Array<{ email: string; displayName: string }>
  hangoutLink?: string
}

export interface FathomMeeting {
  id: string
  title: string
  date: string
  summary: string
  actionItems?: string[]
  keyDecisions?: string[]
}

export interface TaskOperation {
  action: 'add' | 'complete' | 'delete' | 'move'
  task: string
  column?: 'BACKLOG' | 'THIS_WEEK' | 'TODAY' | 'WAITING_ON' | 'DONE'
  priority?: 'NORMAL' | 'WARM' | 'HOT'
  due_date?: string | null
  ts: string
}
