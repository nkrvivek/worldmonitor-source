import { DurableObject } from 'cloudflare:workers';
import { slidingWindowDecide, type WindowState } from './sliding-window';
import { reserveDaily, dailyKey, type MeterStore } from './daily-meter';
import type { CounterRequest, CounterResponse } from './protocol';

interface WindowRow {
  currentCount: number;
  previousCount: number;
  windowStart: number;
}

export class CounterDO extends DurableObject {
  /**
   * Storage is transactional inside a single DO, so the read-modify-write
   * below needs no lock and no Lua. This is the reason the port is possible:
   * every primitive here was reaching for atomicity Redis could only give
   * through EVAL.
   */
  async fetch(request: Request): Promise<Response> {
    const req = (await request.json()) as CounterRequest;
    const result = await this.dispatch(req);
    return Response.json(result);
  }

  private async dispatch(req: CounterRequest): Promise<CounterResponse> {
    switch (req.op) {
      case 'sliding':
        return this.sliding(req);
      case 'daily':
        return this.daily(req);
      case 'daily-read':
        return this.dailyRead(req);
      case 'daily-rollback':
        return this.dailyRollback(req);
      case 'compare-delete':
        return this.compareDelete(req);
      case 'nonce-check':
        return this.nonceCheck(req);
      default: {
        // Exhaustiveness guard. An unknown op must be loud: silently answering
        // "allowed" would disable a limiter with nothing to show for it.
        const unknown: never = req;
        throw new Error(`unknown counter op: ${JSON.stringify(unknown)}`);
      }
    }
  }

  private async sliding(
    req: Extract<CounterRequest, { op: 'sliding' }>,
  ): Promise<CounterResponse> {
    const now = Date.now();
    const stored = await this.ctx.storage.get<WindowRow>(`w:${req.key}`);
    // slidingWindowDecide trusts its caller to have aligned windowStart to a
    // window boundary (Task 1 review) — it does not validate this itself.
    // This is the one call site; get the alignment right here.
    const windowStart = Math.floor(now / req.windowMs) * req.windowMs;

    let state: WindowState;
    if (!stored) {
      state = { currentCount: 0, previousCount: 0, windowStart };
    } else if (stored.windowStart === windowStart) {
      state = stored;
    } else if (stored.windowStart === windowStart - req.windowMs) {
      state = { currentCount: 0, previousCount: stored.currentCount, windowStart };
    } else {
      // Both stored windows are older than the trailing window. Nothing carries.
      state = { currentCount: 0, previousCount: 0, windowStart };
    }

    const decision = slidingWindowDecide(state, now, req.limit, req.windowMs);
    if (decision.success) {
      await this.ctx.storage.put(`w:${req.key}`, { ...state, currentCount: state.currentCount + 1 });
    }
    return { op: 'sliding', success: decision.success, limit: decision.limit, reset: decision.reset };
  }

  private meterStore(): MeterStore {
    return {
      increment: async (key, ttlSeconds) => {
        const current = (await this.ctx.storage.get<number>(key)) ?? 0;
        const next = current + 1;
        await this.ctx.storage.put(key, next);
        if (current === 0) {
          // Mirrors the old EXPIRE-on-every-INCR, minus the wasted command:
          // the TTL only ever needs setting when the key is created.
          const expiresAt = Date.now() + ttlSeconds * 1000;
          await this.ctx.storage.put(`exp:${key}`, expiresAt);
          await this.scheduleSweep(expiresAt);
        }
        return next;
      },
      decrement: async (key) => {
        const current = (await this.ctx.storage.get<number>(key)) ?? 0;
        if (current > 0) await this.ctx.storage.put(key, current - 1);
      },
    };
  }

  private async daily(
    req: Extract<CounterRequest, { op: 'daily' }>,
  ): Promise<CounterResponse> {
    const result = await reserveDaily(this.meterStore(), {
      namespace: req.namespace,
      userId: req.userId,
      allowance: req.allowance,
      ttlSeconds: req.ttlSeconds,
      onStorageFailure: req.posture,
      now: new Date(),
      ceilingMultiplier: req.ceilingMultiplier,
    });
    return {
      op: 'daily',
      allowed: result.allowed,
      metered: result.metered,
      count: result.count,
      overCeiling: result.overCeiling,
      reason: result.reason,
    };
  }

  private async dailyRead(
    req: Extract<CounterRequest, { op: 'daily-read' }>,
  ): Promise<CounterResponse> {
    const key = dailyKey(req.namespace, req.userId, new Date());
    const value = await this.ctx.storage.get<number>(key);
    return { op: 'daily-read', count: value ?? 0, present: value !== undefined };
  }

  private async dailyRollback(
    req: Extract<CounterRequest, { op: 'daily-rollback' }>,
  ): Promise<CounterResponse> {
    await this.meterStore().decrement(dailyKey(req.namespace, req.userId, new Date()));
    return { op: 'daily-rollback', ok: true };
  }

  /**
   * Replay-nonce cache. Storage key is `${namespace}:${nonce}` -- no date
   * component, unlike `dailyKey()` -- so "have I seen this nonce" answers
   * the same way regardless of which side of UTC midnight the check lands
   * on. Reuses `meterStore().increment`, the same primitive `daily` calls,
   * so a first sighting still schedules its own expiry through the alarm
   * sweep above (`scheduleSweep` / `alarm()`) purely off `ttlSeconds` --
   * nothing here reads `Date` to decide when the entry expires.
   */
  private async nonceCheck(
    req: Extract<CounterRequest, { op: 'nonce-check' }>,
  ): Promise<CounterResponse> {
    const key = `${req.namespace}:${req.nonce}`;
    try {
      const count = await this.meterStore().increment(key, req.ttlSeconds);
      if (!Number.isFinite(count) || count < 1) {
        // Mirrors reserveDaily's own nonsense-readback guard: a corrupt
        // counter is a storage fault, not a real "first sighting".
        return { op: 'nonce-check', seen: false, metered: false, reason: 'storage-unavailable' };
      }
      return { op: 'nonce-check', seen: count > 1, metered: true };
    } catch {
      // Fails closed by construction: the route treats `metered: false` the
      // same as `seen: true` (both 401), so a storage failure here can
      // never wave a possible replay through.
      return { op: 'nonce-check', seen: false, metered: false, reason: 'storage-unavailable' };
    }
  }

  private async compareDelete(
    req: Extract<CounterRequest, { op: 'compare-delete' }>,
  ): Promise<CounterResponse> {
    const current = await this.ctx.storage.get<string>(req.key);
    if (current !== req.expected) return { op: 'compare-delete', deleted: false };
    await this.ctx.storage.delete(req.key);
    return { op: 'compare-delete', deleted: true };
  }

  /** Test seam. Not called in production; keeps the CAD test from needing a setter op. */
  async setForTest(key: string, value: string): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  /**
   * A Durable Object has exactly ONE alarm. Setting it unconditionally on every
   * new key would keep pushing the wake-up later and later, so the earliest
   * expiry would never fire on time. Only move the alarm earlier, never later.
   */
  private async scheduleSweep(at: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || at < existing) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const expiries = await this.ctx.storage.list<number>({ prefix: 'exp:' });
    let nextDue: number | null = null;
    for (const [marker, expiresAt] of expiries) {
      if (expiresAt <= now) {
        await this.ctx.storage.delete(marker.slice('exp:'.length));
        await this.ctx.storage.delete(marker);
      } else if (nextDue === null || expiresAt < nextDue) {
        nextDue = expiresAt;
      }
    }
    // Re-arm for whatever is still pending. Without this the sweep runs once
    // and every key written after it lives forever.
    if (nextDue !== null) await this.ctx.storage.setAlarm(nextDue);
  }
}
