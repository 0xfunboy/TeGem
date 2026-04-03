/**
 * Quick diagnostic: dumps the DOM structure of the last Gemini response.
 * Run WHILE the bot is running — connects to the existing browser session
 * by using the same session manager approach.
 *
 * Since we can't attach to the running profile, we use a workaround:
 * evaluate JS directly on a Gemini page via a temporary fresh context,
 * OR just print what we need from a snapshot.
 *
 * Usage: copy-paste the JS below into the browser DevTools console
 * on the Gemini tab, then paste the output here.
 */

const JS_TO_RUN_IN_DEVTOOLS = `
(function() {
  const all = document.querySelectorAll("message-content");
  const topLevel = Array.from(all).filter(
    el => el.parentElement?.closest?.("message-content") === null
  );
  if (topLevel.length === 0) return "No message-content found";
  const root = topLevel[topLevel.length - 1];

  function dumpNode(node, depth) {
    const indent = "  ".repeat(depth);
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.trim();
      if (!text) return "";
      return indent + "TEXT: " + JSON.stringify(text.slice(0, 80)) + "\\n";
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node;
    const tag = el.tagName.toLowerCase();
    const attrs = [];
    if (el.className) attrs.push("class=" + JSON.stringify(el.className.slice(0, 60)));
    if (el.id) attrs.push("id=" + el.id);
    const attrStr = attrs.length ? " " + attrs.join(" ") : "";
    let result = indent + "<" + tag + attrStr + ">\\n";
    for (const child of el.childNodes) {
      result += dumpNode(child, depth + 1);
    }
    return result;
  }

  return dumpNode(root, 0);
})()
`;

console.log("Run this in the browser DevTools console on the Gemini tab:\n");
console.log(JS_TO_RUN_IN_DEVTOOLS);
console.log("\nPaste the output to understand the DOM structure.");
