/**
 * Periodic task scheduler — 1:1 port of module/core/scheduler.py.
 *
 * PeriodicTask runs `run` then waits `interval` seconds; interval and enabled
 * are callables read live each time, so a settings change is picked up without
 * rebuilding the task. Tick exceptions are logged and the loop continues.
 */
import { Logger } from '@nestjs/common';

const logger = new Logger('Scheduler');

export class PeriodicTask {
  private timer: NodeJS.Timeout | null = null;
  private runningTick: Promise<void> | null = null;
  private waitResolve: ((stopped: boolean) => void) | null = null;
  private stopRequested = false;

  constructor(
    public readonly taskName: string,
    private readonly run: () => Promise<void>,
    private readonly interval: () => number,
    private readonly initialDelay: number = 0,
    private readonly enabledFn: () => boolean = () => true,
  ) {}

  get name(): string {
    return this.taskName;
  }

  get enabled(): boolean {
    return this.enabledFn();
  }

  get running(): boolean {
    return this.timer !== null || this.runningTick !== null;
  }

  /** Start the loop. Idempotent while already running. */
  start(): void {
    if (this.running) return;
    this.stopRequested = false;
    void this.loop();
  }

  private async loop(): Promise<void> {
    if (this.initialDelay > 0) {
      if (await this.wait(this.initialDelay)) return;
    }
    while (!this.stopRequested) {
      let tick: Promise<void> | null = null;
      try {
        tick = this.run();
        this.runningTick = tick;
        await tick;
      } catch (e) {
        logger.error(`${this.taskName} tick failed: ${e}`);
      } finally {
        this.runningTick = null;
      }
      if (this.stopRequested) break;
      // 间隔 <= 0（配置为 0）会让循环空转、日志暴涨（#1117），退回 1 秒
      const interval = this.interval();
      if (await this.wait(interval > 0 ? interval : 1)) return;
    }
  }

  /** Sleep up to `timeout` seconds. Return true if a stop was requested. */
  private wait(timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      this.waitResolve = resolve;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.waitResolve = null;
        resolve(this.stopRequested);
      }, timeout * 1000);
    });
  }

  /** Signal stop and wait for the current tick to finish. Idempotent. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // 唤醒悬挂在 wait() 上的循环（否则它的 promise 永不 resolve，协程泄漏）
    const resolve = this.waitResolve;
    this.waitResolve = null;
    resolve?.(true);
    const tick = this.runningTick;
    if (tick) {
      try {
        await tick;
      } catch {
        // tick errors are already logged in the loop
      }
    }
  }
}

export class Scheduler {
  private runningFlag = false;

  constructor(private readonly taskList: PeriodicTask[]) {}

  get tasks(): PeriodicTask[] {
    return this.taskList;
  }

  get running(): boolean {
    return this.runningFlag;
  }

  /** Start every task whose enabled() currently returns true. */
  startAll(): void {
    for (const task of this.taskList) {
      if (task.enabled) task.start();
    }
    this.runningFlag = true;
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.taskList.map((t) => t.stop()));
    this.runningFlag = false;
  }
}
