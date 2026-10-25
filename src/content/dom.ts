/**
 * DOM helpers shared by the site adapters.
 *
 * The interesting part is `writeToEditable`: rich editors (Lexical in DSH,
 * ProseMirror in ChatGPT) keep their own state, so assigning `textContent`
 * leaves the model out of sync and the site may ignore or mangle the draft.
 * `document.execCommand("insertText")` emits the same `beforeinput`/`input`
 * events a typing user produces, which the editors do understand.
 */

export type WriteMethod = "execCommand" | "lineBreaks" | "nativeSetter" | "fallback-dom" | "none";

export interface WriteResult {
  ok: boolean;
  method: WriteMethod;
  /** What the page actually shows after writing — used for verification. */
  actual: string;
  reason?: string;
}

export function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Collapse editor quirks (NBSP, trailing blank line) before comparing text. */
export function normalizeEditorText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function readEditable(element: HTMLElement): string {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return element.value;
  }
  // innerText keeps block boundaries as newlines, which is what the user sees.
  return element.innerText ?? element.textContent ?? "";
}

function selectAllContents(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (selection === null) return false;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export function setNativeValue(element: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set !== undefined) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function insertViaExecCommand(text: string): boolean {
  try {
    return document.execCommand("insertText", false, text);
  } catch {
    return false;
  }
}

function insertLineByLine(text: string): void {
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (index > 0) {
      try {
        document.execCommand("insertLineBreak");
      } catch {
        insertViaExecCommand("\n");
      }
    }
    if (line !== "") insertViaExecCommand(line);
  });
}

function replaceWithTextContent(element: HTMLElement, text: string): void {
  element.textContent = text;
  element.dispatchEvent(
    new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }),
  );
}

/**
 * Replace the editor contents with `text` and verify the page accepted it.
 *
 * Never reports success without reading the text back: a silent mismatch would
 * otherwise be sent to the model as a broken prompt.
 */
export function writeToEditable(element: HTMLElement, text: string): WriteResult {
  element.focus({ preventScroll: false });
  const expected = normalizeEditorText(text);

  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    selectAllContents(element);
    setNativeValue(element, text);
    const actual = normalizeEditorText(readEditable(element));
    return {
      ok: actual === expected,
      method: "nativeSetter",
      actual,
      ...(actual === expected ? {} : { reason: "页面输入框没有接受写入的文本。" }),
    };
  }

  // 1) The events-based path: works with Lexical / ProseMirror state machines.
  if (selectAllContents(element)) {
    // Deleting the current range first avoids appending after existing text
    // when the editor ignores the programmatic selection.
    try {
      document.execCommand("delete");
    } catch {
      /* ignore */
    }
    if (insertViaExecCommand(text)) {
      const actual = normalizeEditorText(readEditable(element));
      if (actual === expected) return { ok: true, method: "execCommand", actual };
    }
  }

  // 2) Same path, but newline-treated separately (some editors drop \n).
  if (text.includes("\n") && selectAllContents(element)) {
    try {
      document.execCommand("delete");
    } catch {
      /* ignore */
    }
    insertLineByLine(text);
    const actual = normalizeEditorText(readEditable(element));
    if (actual === expected) return { ok: true, method: "lineBreaks", actual };
  }

  // 3) Last resort: write the DOM directly and hope the editor reconciles.
  replaceWithTextContent(element, text);
  const actual = normalizeEditorText(readEditable(element));
  return {
    ok: actual === expected,
    method: "fallback-dom",
    actual,
    ...(actual === expected
      ? {}
      : { reason: "编辑器未接受写入（DOM 与内部状态不同步），请手动粘贴译文。" }),
  };
}

/** Dispatch a real Enter key sequence, respecting the site's own handler. */
export function pressEnter(element: HTMLElement, options: { shift?: boolean } = {}): void {
  const shift = options.shift === true;
  const init: KeyboardEventInit = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
    shiftKey: shift,
  };
  element.dispatchEvent(new KeyboardEvent("keydown", init));
  element.dispatchEvent(new KeyboardEvent("keypress", init));
  element.dispatchEvent(new KeyboardEvent("keyup", init));
}
