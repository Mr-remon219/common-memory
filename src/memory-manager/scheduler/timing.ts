export interface SchedulerClock { now(): Date }
export interface SchedulerTimer { set(delayMs: number, callback: () => void): unknown; clear(handle: unknown): void }
export const schedulerClock: SchedulerClock = { now: () => new Date() };
export const schedulerTimer: SchedulerTimer = { set: (delay, callback) => { const handle = setTimeout(callback, delay); handle.unref?.(); return handle; }, clear: (handle) => clearTimeout(handle as NodeJS.Timeout) };
