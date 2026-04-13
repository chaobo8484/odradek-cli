import chalk from 'chalk';
import spinners from 'unicode-animations';
import type { BrailleSpinnerName } from 'unicode-animations';

export class Spinner {
  private static readonly FALLBACK_FRAMES = ['-', '\\', '|', '/'];
  private readonly frames: readonly string[];
  private readonly frameInterval: number;
  private readonly frameColor = chalk.hex('#D6F54A');
  private currentFrame = 0;
  private interval: NodeJS.Timeout | null = null;
  private message = '';
  private startedAt = 0;

  constructor(animationName: BrailleSpinnerName = 'cascade') {
    const animation = spinners[animationName];
    this.frames =
      animation && Array.isArray(animation.frames) && animation.frames.length > 0
        ? animation.frames
        : Spinner.FALLBACK_FRAMES;
    this.frameInterval = animation && animation.interval > 0 ? animation.interval : 80;
  }

  start(message: string): void {
    this.message = message;
    this.currentFrame = 0;
    this.startedAt = Date.now();

    this.render();

    this.interval = setInterval(() => {
      this.render();
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
    }, this.frameInterval);
  }

  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    process.stdout.write('\r\x1b[K');

    if (finalMessage) {
      console.log(chalk.dim('  | ') + chalk.green('+') + ' ' + chalk.gray(finalMessage));
    }
  }

  fail(errorMessage: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    process.stdout.write('\r\x1b[K');
    console.log(chalk.dim('  | ') + chalk.red('x') + ' ' + chalk.red(errorMessage));
  }

  private render(): void {
    const elapsed = this.formatElapsed(Date.now() - this.startedAt);
    process.stdout.write(
      '\r' +
        chalk.dim('  | ') +
        this.frameColor(this.frames[this.currentFrame]) +
        ' ' +
        chalk.gray(`${this.message} (${elapsed})`)
    );
  }

  private formatElapsed(elapsedMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes === 0) {
      return `${seconds}s`;
    }

    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
}
