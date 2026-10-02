const sensitive = /password|passwd|secret|token|credential|authorization|api.?key|database.?url|taskdata.?url|pguser/i

/** Retain the cause while excluding private configuration and connection URLs. */
export function safeError(error, ...sources) {
  const secrets = new Set()
  function collect(value, privateValue = false) {
    if (typeof value === 'string') {
      if (privateValue && value) secrets.add(value)
      try {
        const url = new URL(value)
        if (url.password) { secrets.add(url.password); secrets.add(decodeURIComponent(url.password)) }
        if (url.username && /^postgres(?:ql)?:$/.test(url.protocol)) secrets.add(decodeURIComponent(url.username))
        for (const [key, secret] of url.searchParams) if (sensitive.test(key) && secret) secrets.add(secret)
      } catch { /* Ordinary configuration strings are not URLs. */ }
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) collect(item, privateValue || sensitive.test(key))
    }
  }
  for (const source of sources) collect(source)
  let message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Installer failed.'
  message = message.replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s'"<>]+/gi, '[database URL redacted]')
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s/@]+:[^\s/@]*@[^\s'"<>]+/gi, '[credential URL redacted]')
    .replace(/\bBearer\s+[^\s'"<>]+/gi, 'Bearer [redacted]')
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) message = message.replaceAll(secret, '[redacted]')
  message = message.replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
  return message.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 8192)
}
