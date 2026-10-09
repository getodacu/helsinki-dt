export interface AssetProgress { discovering: boolean; completed: number; total: number; failed: number }
export interface BackgroundProgress { phase: 'idle' | 'discovering' | 'loading' | 'complete' | 'partial' | 'stopped'; completed: number; total: number; failed: number }
export interface SceneLoadState {
  phase: 'discovering' | 'loading' | 'rendering' | 'ready' | 'error' | 'available';
  completed: number; total: number; failed: number; background: BackgroundProgress; cacheIssue: string;
}

/** A complete asset set is not ready until its revision has actually rendered. */
export class ViewLoading {
  private view = '';
  private renderedRevision = -1;
  private available = false;
  update(view: string, revision: number, progress: AssetProgress, background: BackgroundProgress, cacheIssue: string): SceneLoadState {
    if (this.view !== view) { this.view = view; this.available = false; this.renderedRevision = -1; }
    if (!progress.discovering && progress.failed && progress.completed + progress.failed === progress.total) this.available = true;
    const complete = !progress.discovering && !progress.failed && progress.completed === progress.total;
    const phase = this.available && this.renderedRevision >= 0 && this.renderedRevision !== revision ? 'available' : (complete || this.available) && this.renderedRevision === revision ? complete ? 'ready' : 'available'
      : this.available ? 'rendering' : progress.failed ? 'error' : progress.discovering ? 'discovering' : complete ? 'rendering' : 'loading';
    return { phase, completed: progress.completed, total: progress.total, failed: progress.failed, background, cacheIssue };
  }
  rendered(revision: number) { this.renderedRevision = revision; }
  openAvailable() { this.available = true; }
  retry() { this.available = false; this.renderedRevision = -1; }
}

/** Missing parts retry quietly with bounded backoff, including across camera changes. */
export class AssetRetries {
  private failures = new Map<string, { attempts: number; due: number }>();
  fail(key: string, now = Date.now()) {
    const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
    this.failures.set(key, { attempts, due: now + Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)) });
  }
  has(key: string) { return this.failures.has(key); }
  ready(key: string, now = Date.now()) { return now >= (this.failures.get(key)?.due ?? 0); }
  nextDue(keys: Iterable<string>) {
    let due = Infinity;
    for (const key of keys) due = Math.min(due, this.failures.get(key)?.due ?? Infinity);
    return due;
  }
  delete(key: string) { this.failures.delete(key); }
  clear() { this.failures.clear(); }
}
