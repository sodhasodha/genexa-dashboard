interface MetricCardProps {
  label: string
  value: string | number
  subtitle?: string
  color?: 'green' | 'red' | 'muted' | 'blue'
}

export default function MetricCard({ label, value, subtitle, color = 'muted' }: MetricCardProps) {
  const colorClasses = {
    green: 'text-los-green',
    red: 'text-los-red',
    muted: 'text-los-text-muted',
    blue: 'text-los-accent',
  }

  return (
    <div className="los-card p-5">
      <div className="los-label mb-2">{label}</div>
      <div className="los-metric-number text-los-text mb-1">{value}</div>
      {subtitle && (
        <div className={`text-xs ${colorClasses[color]}`}>{subtitle}</div>
      )}
    </div>
  )
}
