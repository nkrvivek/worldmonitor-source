/**
 * Outbound email copy may only name notification channels this fork offers.
 *
 * The settings panel already draws from OFFERED_NOTIFICATION_CHANNELS, so a
 * channel dropped from that list disappears from the UI on its own. Email copy
 * is hand-written prose and does not, which is how three templates came to
 * promise buyers "Slack, Telegram, WhatsApp, Email, Discord": Discord was taken
 * out because we run no Discord app, and WhatsApp has never been a ChannelType
 * at all -- not in this fork and not upstream.
 *
 * Scans source only. convex/_generated/ is the artifact of the last Convex
 * deploy pushed back into the repo; it catches up when the next deploy runs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { OFFERED_NOTIFICATION_CHANNELS } from '../src/config/notification-channels-offered.ts';

// Files that state the channel list to a reader outside the app.
const OUTBOUND_COPY = [
  'convex/payments/subscriptionEmails.ts',
  'convex/broadcast/proLaunchEmailContent.ts',
  'server/worldmonitor/leads/v1/register-interest.ts',
];

// Channel words that must not appear in that copy. 'discord' is a ChannelType
// this fork does not offer; 'whatsapp' names no channel that ever existed.
const NOT_OFFERED = ['discord', 'whatsapp'];

// Only lines that enumerate channels are copy about delivery. The same words
// appear in these files for unrelated reasons -- register-interest.ts draws a
// WhatsApp button for sharing the email itself -- and a flat scan cannot tell
// the two apart. A line naming two or more offered channels is a channel list.
function namesTwoOfferedChannels(line: string): boolean {
  const hits = OFFERED_NOTIFICATION_CHANNELS.filter((channel) =>
    line.includes(channel === 'web_push' ? 'browser push' : channel),
  );
  return hits.length >= 2;
}

describe('outbound email copy', () => {
  // Guards the guard: re-offering a channel means editing this list too, and a
  // plain scan would otherwise keep failing on copy that had become correct.
  it('does not forbid a channel the settings panel offers', () => {
    for (const word of NOT_OFFERED) {
      assert.ok(
        !OFFERED_NOTIFICATION_CHANNELS.includes(word as never),
        `${word} is offered now — drop it from NOT_OFFERED in this test`,
      );
    }
  });

  for (const file of OUTBOUND_COPY) {
    it(`${file} lists no channel we do not offer`, () => {
      const lines = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
        .toLowerCase()
        .split('\n');
      const channelLists = lines.filter(namesTwoOfferedChannels);
      assert.ok(channelLists.length > 0, `${file} no longer lists channels — update this test`);
      for (const line of channelLists) {
        for (const word of NOT_OFFERED) {
          assert.ok(!line.includes(word), `${file} still offers ${word}: ${line.trim()}`);
        }
      }
    });
  }
});
