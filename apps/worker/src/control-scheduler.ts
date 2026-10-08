import { DurableObject } from "cloudflare:workers";
import { type Bindings, runtime } from "./runtime";

const INTERVAL_MS = 60_000;

export class ControlScheduler extends DurableObject<Bindings> {
  async ensureScheduled(): Promise<void> {
    // Native storage input gates serialize this read/write with other events.
    // Preserve an existing deadline rather than postponing it on each request.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + INTERVAL_MS);
    }
  }

  async alarm(): Promise<void> {
    // During an alarm, getAlarm() is null unless its successor is already armed.
    // Persist the next tick before external I/O, including a failed D1 drain.
    await this.ensureScheduled();
    await runtime(this.env).execution.drain();
  }
}
