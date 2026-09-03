/**
 * Which notification channels this deployment offers.
 *
 * Fork-owned file. Upstream ships a Discord channel with its own OAuth flow;
 * we do not run a Discord app, so offering the row would hand people a connect
 * button that cannot finish. The channel type, the API routes, and the Convex
 * schema all stay as upstream wrote them — this list only decides what the
 * settings panel draws.
 *
 * To offer a channel again, add it back here. Nothing else needs to change.
 */

// boundary-ignore: type-only import, erased at build, so no runtime coupling
import type { ChannelType } from '@/services/notification-channels';

/** Drawn in the settings panel, in this order. */
export const OFFERED_NOTIFICATION_CHANNELS: readonly ChannelType[] = [
  'telegram',
  'email',
  'slack',
  'webhook',
  'web_push',
];

export function isChannelOffered(type: ChannelType): boolean {
  return OFFERED_NOTIFICATION_CHANNELS.includes(type);
}
