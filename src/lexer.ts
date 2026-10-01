// Tokenizer for the subset of MQL5 we convert. MQL5 is C++-like, so this is a
// small C-style lexer plus handling for preprocessor lines (#property, #include).

export type TokenKind = "ident" | "number" | "string" | "char" | "op" | "punct" | "directive" | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
}

export class LexError extends Error {
  constructor(message: string, public line: number, public col: number) {
    super(`${message} (line ${line}, col ${col})`);
  }
}

// Longest operators first so "<<=" wins over "<<" and "<".
const OPERATORS = [
  "<<=", ">>=", "...",
  "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=",
  "&=", "|=", "^=", "<<", ">>", "->", "::",
  "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~", "?", ":", ".",
];
const PUNCT = new Set(["(", ")", "{", "}", "[", "]", ";", ","]);

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let atLineStart = true;

  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") {
        line++;
        col = 1;
        atLineStart = true;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === "\n") {
      advance(1);
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v" || ch === "﻿") {
      advance(1);
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") advance(1);
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      advance((end === -1 ? src.length : end + 2) - i);
      continue;
    }

    const startLine = line;
    const startCol = col;

    // Preprocessor directive: the whole logical line (with \ continuations).
    if (ch === "#" && atLineStart) {
      let text = "";
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\" && src[i + 1] === "\n") {
          advance(2);
          text += " ";
          continue;
        }
        if (src[i] === "/" && src[i + 1] === "/") {
          while (i < src.length && src[i] !== "\n") advance(1);
          break;
        }
        text += src[i];
        advance(1);
      }
      tokens.push({ kind: "directive", value: text.trim(), line: startLine, col: startCol });
      continue;
    }
    atLineStart = false;

    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: "ident", value: src.slice(i, j), line: startLine, col: startCol });
      advance(j - i);
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      if (ch === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        j += 2;
        while (j < src.length && /[0-9A-Fa-f]/.test(src[j])) j++;
      } else {
        while (j < src.length && /[0-9]/.test(src[j])) j++;
        if (src[j] === ".") {
          j++;
          while (j < src.length && /[0-9]/.test(src[j])) j++;
        }
        if (src[j] === "e" || src[j] === "E") {
          let k = j + 1;
          if (src[k] === "+" || src[k] === "-") k++;
          if (/[0-9]/.test(src[k] ?? "")) {
            j = k;
            while (j < src.length && /[0-9]/.test(src[j])) j++;
          }
        }
      }
      // Suffixes like 1.0f, 10L, 5u
      while (j < src.length && /[fFlLuU]/.test(src[j])) j++;
      tokens.push({ kind: "number", value: src.slice(i, j), line: startLine, col: startCol });
      advance(j - i);
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const esc = src[j + 1];
          value += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc;
          j += 2;
          continue;
        }
        if (src[j] === "\n") throw new LexError("Unterminated string", startLine, startCol);
        value += src[j];
        j++;
      }
      if (j >= src.length) throw new LexError("Unterminated string", startLine, startCol);
      tokens.push({ kind: quote === '"' ? "string" : "char", value, line: startLine, col: startCol });
      advance(j + 1 - i);
      continue;
    }

    if (PUNCT.has(ch)) {
      tokens.push({ kind: "punct", value: ch, line: startLine, col: startCol });
      advance(1);
      continue;
    }

    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ kind: "op", value: op, line: startLine, col: startCol });
      advance(op.length);
      continue;
    }

    throw new LexError(`Unexpected character '${ch}'`, startLine, startCol);
  }

  tokens.push({ kind: "eof", value: "", line, col });
  return tokens;
}
