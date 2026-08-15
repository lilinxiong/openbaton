/**
 * Unlimited logical spawn count. Wide fan-out queues; it never refuses.
 * max_concurrent is a process-health valve, not a product cap.
 */

export const START = "start";
export const ENQUEUE = "enqueue";

export class DispatchQueue {
  constructor(maxConcurrent = 4) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.running = 0;
    this.queued = 0;
  }

  static fromConfig(cfg) {
    return new DispatchQueue(cfg?.director?.max_concurrent ?? 4);
  }

  admit() {
    return this.running < this.maxConcurrent ? START : ENQUEUE;
  }

  noteStarted() {
    if (this.queued > 0) this.queued -= 1;
    this.running += 1;
  }

  noteEnqueued() {
    this.queued += 1;
  }

  noteFinished() {
    this.running = Math.max(0, this.running - 1);
  }

  /**
   * Plan N units. Always admits all of them (start or queue). Never rejects.
   */
  plan(count) {
    const decisions = [];
    for (let i = 0; i < count; i += 1) {
      const decision = this.admit();
      if (decision === START) this.noteStarted();
      else this.noteEnqueued();
      decisions.push(decision);
    }
    return decisions;
  }

  snapshot() {
    return {
      max_concurrent: this.maxConcurrent,
      running: this.running,
      queued: this.queued,
    };
  }
}
