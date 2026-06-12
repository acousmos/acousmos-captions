import type { AsrProviderId } from '../../shared/types'
import type { AsrProvider } from './types'
import { deepgram } from './deepgram'
import { soniox } from './soniox'

const providers: Record<AsrProviderId, AsrProvider> = { deepgram, soniox }

export function getAsrProvider(id: AsrProviderId): AsrProvider {
  return providers[id]
}

export type { AsrOptions, AsrProvider } from './types'
