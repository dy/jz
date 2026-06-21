// === AST op tags — integer-tagged-union representation ===
// internOps (prepare->compile boundary) converts array node[0] from op STRING to its
// integer tag; the compile half then dispatches via integer-keyed (eventually array)
// tables, removing the per-node string-hash lookup in the self-host kernel.
// OP: string -> int (1-based; 0 reserved => a missing tag is falsy). OPS: int -> string.
export const OP = {
  "!": 1,
  "!=": 2,
  "!==": 3,
  "%": 4,
  "%=": 5,
  "&": 6,
  "&&": 7,
  "&&=": 8,
  "&=": 9,
  "(": 10,
  "()": 11,
  "*": 12,
  "**": 13,
  "*=": 14,
  "+": 15,
  "++": 16,
  "+=": 17,
  ",": 18,
  "-": 19,
  "--": 20,
  "-=": 21,
  ".": 22,
  "...": 23,
  "/": 24,
  "//": 25,
  "/=": 26,
  ";": 27,
  "<": 28,
  "<<": 29,
  "<<=": 30,
  "<=": 31,
  "=": 32,
  "==": 33,
  "===": 34,
  "=>": 35,
  ">": 36,
  ">=": 37,
  ">>": 38,
  ">>=": 39,
  ">>>": 40,
  ">>>=": 41,
  "?": 42,
  "?:": 43,
  "??": 44,
  "??=": 45,
  "[": 46,
  "[]": 47,
  "^": 48,
  "^=": 49,
  "async": 50,
  "await": 51,
  "bigint": 52,
  "block": 53,
  "bool": 54,
  "break": 55,
  "call": 56,
  "catch": 57,
  "const": 58,
  "continue": 59,
  "default": 60,
  "delete": 61,
  "export": 62,
  "finally": 63,
  "for": 64,
  "if": 65,
  "import": 66,
  "in": 67,
  "instanceof": 68,
  "label": 69,
  "let": 70,
  "nan": 71,
  "new": 72,
  "return": 73,
  "spread": 74,
  "str": 75,
  "strcat": 76,
  "switch": 77,
  "throw": 78,
  "typeof": 79,
  "u+": 80,
  "u-": 81,
  "void": 82,
  "while": 83,
  "yield": 84,
  "{": 85,
  "{}": 86,
  "|": 87,
  "|=": 88,
  "||": 89,
  "||=": 90,
  "~": 91,
}
export const OPS = [null, "!", "!=", "!==", "%", "%=", "&", "&&", "&&=", "&=", "(", "()", "*", "**", "*=", "+", "++", "+=", ",", "-", "--", "-=", ".", "...", "/", "//", "/=", ";", "<", "<<", "<<=", "<=", "=", "==", "===", "=>", ">", ">=", ">>", ">>=", ">>>", ">>>=", "?", "?:", "??", "??=", "[", "[]", "^", "^=", "async", "await", "bigint", "block", "bool", "break", "call", "catch", "const", "continue", "default", "delete", "export", "finally", "for", "if", "import", "in", "instanceof", "label", "let", "nan", "new", "return", "spread", "str", "strcat", "switch", "throw", "typeof", "u+", "u-", "void", "while", "yield", "{", "{}", "|", "|=", "||", "||=", "~"]
export const OP_COUNT = 92

// Normalize an op tag to its string form for op-Set membership / switch checks,
// so `SET.has(opStr(node[0]))` and `switch (opStr(op))` work whether node[0] is
// still a string (intern off / non-interned op like ':') or an integer (intern
// on). Self-host-safe: the typeof guard avoids indexing the OPS array by a string
// (jz arrays trap on non-integer indices), and it never grows a Set.
export const opStr = (op) => typeof op === "number" ? OPS[op] : op

// Convert array node[0] from op-STRING to integer tag, recursively. Once per node at
// the prepare boundary. Unknown op-strings stay strings (dual-keyed tables handle them
// until the int-only phase). node[0]===null (numeric literal) stays null; identifiers
// (bare strings at n[1+]) untouched.
export const internOps = (n) => {
  if (!Array.isArray(n)) return n
  const t = n[0]
  if (typeof t === "string") { const id = OP[t]; if (id !== undefined) n[0] = id }
  for (let i = 1; i < n.length; i++) if (Array.isArray(n[i])) internOps(n[i])
  return n
}
