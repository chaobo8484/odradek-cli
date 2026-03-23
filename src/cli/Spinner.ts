import chalk from 'chalk';

export class Spinner {
  private frames = ['-', '\\', '|', '/'];
  private currentFrame = 0;
  private interval: NodeJS.Timeout | null = null;
  private message = '';

  start(message: string): void {
    this.message = message;
    this.currentFrame = 0;

    this.interval = setInterval(() => {
      process.stdout.write(
        '\r' + chalk.dim('  | ') + chalk.cyan(this.frames[this.currentFrame]) + ' ' + chalk.gray(this.message)
      );
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
    }, 80);
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
}
