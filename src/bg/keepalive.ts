/**
 * MV3 service workers idle out after ~30s. While jobs are running, a periodic
 * trivial extension-API call keeps the worker alive (standard pattern).
 */

let active = 0
let timer: ReturnType<typeof setInterval> | undefined

export function jobStarted(): void {
  if (active++ === 0) {
    timer = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000)
  }
}

export function jobEnded(): void {
  active = Math.max(0, active - 1)
  if (active === 0 && timer) {
    clearInterval(timer)
    timer = undefined
  }
}
