/**
 * IME (input method) guard.
 *
 * While a Chinese/Japanese/Korean composition is in progress the editor must not
 * be read or written: rewriting a Lexical editor mid-composition is what turns
 * "ni hao" into scattered pinyin fragments. We therefore listen at the document
 * level in the capture phase (the composer itself may be re-created by React)
 * and keep a short cooldown after `compositionend`, because some IMEs commit the
 * final characters a few milliseconds later.
 */

const COOLDOWN_MS = 60;

export class ImeGuard {
  private attached = false;
  private composing = false;
  private endedAt = Number.NEGATIVE_INFINITY;
  private readonly doc: Document | undefined;

  /** `doc` is optional so the module can be imported before a DOM exists (tests). */
  constructor(doc?: Document) {
    this.doc = doc;
  }

  attach(): this {
    if (this.attached) return this;
    const doc = this.doc ?? document;
    this.attached = true;

    const onStart = () => {
      this.composing = true;
    };
    const onEnd = () => {
      this.composing = false;
      this.endedAt = performance.now();
    };
    doc.addEventListener("compositionstart", onStart, true);
    doc.addEventListener("compositionend", onEnd, true);
    // Safari/Chrome edge case: composition can end without a compositionend when
    // the editor loses focus mid-composition.
    doc.addEventListener("blur", onEnd, true);
    return this;
  }

  get isComposing(): boolean {
    return this.composing;
  }

  /** True when it is safe to read or mutate the editor right now. */
  isSafe(cooldownMs: number = COOLDOWN_MS): boolean {
    if (this.composing) return false;
    return performance.now() - this.endedAt > cooldownMs;
  }
}

/** Shared instance; scripts should not create their own guards. */
export const imeGuard = new ImeGuard();
