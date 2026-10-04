/** Plain words for an effort level Core reports. */
const effortNames: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}
export const effortLabel = (effort: string) =>
  effortNames[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1)

/** A daily `HH:MM` time in this device's clock style. */
export function clockTime(value: string) {
  const [hours, minutes] = value.split(':').map(Number)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return value
  const date = new Date(2000, 0, 1, hours, minutes)
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export const errorText = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'Not saved.'
