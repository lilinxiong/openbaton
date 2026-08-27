/**
 * Unlimited logical spawn count. Wide fan-out queues; it never refuses.
 *
 * This queue is only director planning metadata. Its planning valve must not
 * be confused with dispatchSnapshot's tree-local runtime capacity or its
 * `capacity`/`available` fields.
 */

export const START = "start";
export const ENQUEUE = "enqueue";

export class DispatchQueue {
  readonly planningMaxConcurrent: number;
  running: number;
  queued: number;

  constructor(planningMaxConcurrent = 4) {
    this.planningMaxConcurrent = Math.max(1, planningMaxConcurrent);
    this.running = 0;
    this.queued = 0;
  }

  static fromConfig(cfg: { director?: { max_concurrent?: number } } | null | undefined): DispatchQueue {
    // `director.max_concurrent` is a policy input for planning only here.
    // Runtime dispatch resolves host/session capacity independently.
    return new DispatchQueue(cfg?.director?.max_concurrent ?? 4);
  }

  admit(): typeof START | typeof ENQUEUE {
    return this.running < this.planningMaxConcurrent ? START : ENQUEUE;
  }

  noteStarted(): void {
    if (this.queued > 0) this.queued -= 1;
    this.running += 1;
  }

  noteEnqueued(): void {
    this.queued += 1;
  }

  noteFinished(): void {
    this.running = Math.max(0, this.running - 1);
  }

  /**
   * Plan N units. Always admits all of them (start or queue). Never rejects.
   */
  plan(count: number): Array<typeof START | typeof ENQUEUE> {
    const decisions: Array<typeof START | typeof ENQUEUE> = [];
    for (let i = 0; i < count; i += 1) {
      const decision = this.admit();
      if (decision === START) this.noteStarted();
      else this.noteEnqueued();
      decisions.push(decision);
    }
    return decisions;
  }

  snapshot(): { scope: "director-planning"; planning_max_concurrent: number; running: number; queued: number } {
    return {
      scope: "director-planning",
      planning_max_concurrent: this.planningMaxConcurrent,
      running: this.running,
      queued: this.queued,
    };
  }
}
