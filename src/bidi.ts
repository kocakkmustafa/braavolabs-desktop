/**
 * Paths, repos, branches, URLs, commands and identifiers are LTR data even inside an RTL locale (ar).
 * `dir="ltr"` also isolates the run (UA stylesheet: unicode-bidi isolate), so "a/b → main" keeps its order.
 * One helper, applied to the node that carries the value; the text itself is never changed.
 */
export function ltr<T extends HTMLElement>(node: T): T {
  node.dir = "ltr";
  return node;
}
