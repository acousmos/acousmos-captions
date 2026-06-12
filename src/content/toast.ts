let host: HTMLDivElement | null = null

/** Lightweight transient notice, bottom-center of the viewport. */
export function toast(message: string, ms = 3500): void {
  if (!host) {
    host = document.createElement('div')
    host.className = 'acap-toast-host'
    document.documentElement.appendChild(host)
  }
  const el = document.createElement('div')
  el.className = 'acap-toast'
  el.textContent = message
  host.appendChild(el)
  requestAnimationFrame(() => el.classList.add('acap-toast-in'))
  setTimeout(() => {
    el.classList.remove('acap-toast-in')
    setTimeout(() => el.remove(), 300)
  }, ms)
}
