// Compound undo steps over the Editor's stack: "clear the box's text" (one setText per paragraph) is one step for the
// user. A group is remembered by the stack length at its end; undoing it undoes every edit in it, and redoing redoes
// them all.
import type { Editor } from '../src/model/edit.ts';

export class History {
  private ed: Editor;
  private undoGroups = new Map<number, number>();   // stack length at the group's end → edits in it
  private redoGroups = new Map<number, number>();   // stack length after the group was undone → edits in it
  private inGroup = false;
  private lastLen = 0;

  constructor(ed: Editor) {
    this.ed = ed;
  }

  /** Runs `fn`; every edit it makes is one undo step. */
  group<T>(fn: () => T): T {
    const a = this.ed.history.length;
    this.inGroup = true;
    try {
      return fn();
    } finally {
      this.inGroup = false;
      const b = this.ed.history.length;
      this.prune(a);
      this.redoGroups.clear();
      if (b - a > 1) this.undoGroups.set(b, b - a);
      this.lastLen = b;
    }
  }

  /** Call on every new edit ('do'): groups the new edit replaced are forgotten. */
  onDo(): void {
    if (this.inGroup) return;
    const L = this.ed.history.length;
    // a merged edit (a keystroke folded into the one on top) leaves the stack as it was
    if (L !== this.lastLen) this.prune(L - 1);
    this.lastLen = L;
    this.redoGroups.clear();
  }

  undo(): void {
    const L = this.ed.history.length;
    const k = this.undoGroups.get(L) ?? 1;
    for (let i = 0; i < k; i++) this.ed.undo();
    if (k > 1) { this.undoGroups.delete(L); this.redoGroups.set(L - k, k); }
    this.lastLen = this.ed.history.length;
  }

  redo(): void {
    const L = this.ed.history.length;
    const k = this.redoGroups.get(L) ?? 1;
    for (let i = 0; i < k; i++) this.ed.redo();
    if (k > 1) { this.redoGroups.delete(L); this.undoGroups.set(L + k, k); }
    this.lastLen = this.ed.history.length;
  }

  /** Steps the user can undo (a group counts once). */
  get steps(): number {
    let n = this.ed.history.length;
    for (const [, k] of this.undoGroups) n -= k - 1;
    return n;
  }

  private prune(from: number): void {
    for (const L of [...this.undoGroups.keys()]) if (L > from) this.undoGroups.delete(L);
  }
}
