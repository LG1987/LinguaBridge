/**
 * Extract readable text from a message subtree.
 *
 * `innerText` requires layout and behaves badly on detached clones, so message
 * extraction walks the tree and re-inserts newlines at block boundaries. Code
 * fences keep their internal line breaks because `<pre>` is copied verbatim.
 */

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "DL",
  "DT",
  "DD",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "TEMPLATE"]);

export function elementToText(root: Node): string {
  let output = "";

  const appendBreak = (count = 1) => {
    if (output.endsWith("\n")) return;
    output += "\n".repeat(count);
  };

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      output += node.nodeValue ?? "";
      return;
    }
    if (!(node instanceof HTMLElement)) {
      node.childNodes.forEach(walk);
      return;
    }

    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return;
    if (node.hidden) return;
    if (node.dataset["linguabridge"] !== undefined) return;
    if (node.getAttribute("aria-hidden") === "true") return;
    if (tag === "BUTTON") return;

    if (tag === "BR") {
      output += "\n";
      return;
    }

    // Code: take the raw text so indentation survives.
    if (tag === "PRE") {
      appendBreak();
      output += (node.textContent ?? "").replace(/\u00a0/g, " ");
      appendBreak();
      return;
    }

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) appendBreak();
    // Markdown list items read better with a dash than with bare lines.
    if (tag === "LI") {
      output += "- ";
    }
    node.childNodes.forEach(walk);
    if (isBlock) appendBreak();
  };

  walk(root);

  return output
    .replace(/\u00a0/g, " ")
    // Drop spaces that our synthetic line breaks left behind.
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extract text of the current selection, ignoring selections inside our UI. */
export function selectedText(): string {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return "";
  const anchor = selection.anchorNode;
  if (anchor !== null) {
    const element = anchor instanceof Element ? anchor : anchor.parentElement;
    if (element?.closest("[data-linguabridge]") !== null && element !== null) return "";
  }
  return selection.toString().trim();
}
