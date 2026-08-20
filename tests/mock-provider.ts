import type { ImageGenerationProvider, GeneratedImage } from '../src/shared/types';

/**
 * Mock ImageGenerationProvider for testing the queue without ChatGPT.
 *
 * Configurable success/failure/delay behavior.
 */
export class MockProvider implements ImageGenerationProvider {
  private available = true;
  private delayMs = 100;
  private shouldFail = false;
  private failMessage = 'Mock generation failed';
  private callCount = 0;
  private failOnAttempts: Set<number> = new Set();

  /** Configure availability */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /** Configure delay per generation */
  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  /** Configure all generations to fail */
  setFail(fail: boolean, message?: string): void {
    this.shouldFail = fail;
    if (message) this.failMessage = message;
  }

  /** Configure specific attempt numbers to fail (1-indexed) */
  setFailOnAttempts(attempts: number[]): void {
    this.failOnAttempts = new Set(attempts);
  }

  /** Get total call count */
  getCallCount(): number {
    return this.callCount;
  }

  /** Reset state */
  reset(): void {
    this.available = true;
    this.delayMs = 100;
    this.shouldFail = false;
    this.failMessage = 'Mock generation failed';
    this.callCount = 0;
    this.failOnAttempts.clear();
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async generateImage(prompt: string): Promise<GeneratedImage> {
    this.callCount++;

    await new Promise((resolve) => setTimeout(resolve, this.delayMs));

    const shouldFailThisTime =
      this.shouldFail || this.failOnAttempts.has(this.callCount);

    if (shouldFailThisTime) {
      throw new Error(this.failMessage);
    }

    // Return a fake data URL (1x1 white PNG)
    const fakeImageUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

    return {
      url: fakeImageUrl,
      width: 1024,
      height: 1024,
    };
  }
}
