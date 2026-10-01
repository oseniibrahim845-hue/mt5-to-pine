import { tokenize, Token } from "./lexer.js";
import type {
  Declarator,
  Directive,
  EnumDecl,
  Expr,
  FuncDecl,
  Param,
  Program,
  Stmt,
  SwitchCase,
  TopItem,
  VarDecl,
} from "./ast.js";

export class ParseError extends Error {
  constructor(message: string, public line: number) {
    super(`${message} (line ${line})`);
  }
}

const MODIFIERS = new Set(["static", "const", "input", "sinput", "extern", "virtual", "override"]);
const KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "return", "break", "continue", "switch", "case", "default",
  "new", "delete", "sizeof", "class", "struct", "enum", "true", "false", "NULL", "this", "goto",
  "public", "private", "protected", "template", "typename", "operator",
]);
export const BUILTIN_TYPES = new Set([
  "void", "bool", "char", "uchar", "short", "ushort", "int", "uint", "long", "ulong",
  "float", "double", "string", "datetime", "color",
]);

const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6, "!=": 6,
  "<": 7, ">": 7, "<=": 7, ">=": 7,
  "<<": 8, ">>": 8,
  "+": 9, "-": 9,
  "*": 10, "/": 10, "%": 10,
};
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

export function parse(src: string): Program {
  return new Parser(tokenize(src)).parseProgram();
}

/** Parse a single expression, e.g. the value of a #define. */
export function parseExpression(src: string): Expr {
  const p = new Parser(tokenize(src));
  const e = p.parseExpr();
  if (!p.atEnd()) throw new ParseError("Unexpected text after expression", 1);
  return e;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  atEnd(): boolean {
    return this.peek().kind === "eof";
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }
  private is(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return (t.kind === "punct" || t.kind === "op" || t.kind === "ident") && t.value === value;
  }
  private eat(value: string): boolean {
    if (this.is(value)) {
      this.next();
      return true;
    }
    return false;
  }
  private expect(value: string): Token {
    const t = this.peek();
    if (!this.is(value)) throw new ParseError(`Expected '${value}' but found '${t.value || t.kind}'`, t.line);
    return this.next();
  }
  private expectIdent(): Token {
    const t = this.peek();
    if (t.kind !== "ident") throw new ParseError(`Expected a name but found '${t.value || t.kind}'`, t.line);
    return this.next();
  }

  /** Skip a balanced {...} block starting at the current '{'. */
  private skipBraces(): void {
    this.expect("{");
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind === "eof") throw new ParseError("Unexpected end of file inside a block", t.line);
      if (t.kind === "punct" && t.value === "{") depth++;
      if (t.kind === "punct" && t.value === "}") depth--;
    }
  }

  parseProgram(): Program {
    const directives: Directive[] = [];
    const items: TopItem[] = [];
    while (this.peek().kind !== "eof") {
      const t = this.peek();
      if (t.kind === "directive") {
        directives.push({ text: t.value, line: t.line });
        this.next();
        continue;
      }
      if (this.eat(";")) continue;
      items.push(...this.parseTopItem());
    }
    return { directives, items };
  }

  private parseTopItem(): TopItem[] {
    const start = this.peek();

    if (this.is("enum")) return [this.parseEnum()];

    if (this.is("class") || this.is("struct") || this.is("union") || this.is("interface")) {
      const kind = this.next().value;
      const name = this.peek().kind === "ident" ? this.next().value : "(anonymous)";
      // skip inheritance list
      while (!this.is("{") && !this.is(";") && this.peek().kind !== "eof") this.next();
      if (this.is("{")) this.skipBraces();
      this.eat(";");
      return [{ type: "Unsupported", what: `${kind} ${name}`, line: start.line }];
    }

    if (this.is("template")) {
      // template<typename T> ... : skip the whole following declaration
      while (!this.is("{") && !this.is(";") && this.peek().kind !== "eof") this.next();
      if (this.is("{")) this.skipBraces();
      this.eat(";");
      return [{ type: "Unsupported", what: "template", line: start.line }];
    }

    // `input group "Settings"` is only a UI label in MT5.
    if ((this.is("input") || this.is("sinput")) && this.is("group", 1)) {
      this.next();
      this.next();
      while (this.peek().kind === "string") this.next();
      this.eat(";");
      return [];
    }

    const modifiers: string[] = [];
    while (this.peek().kind === "ident" && MODIFIERS.has(this.peek().value)) modifiers.push(this.next().value);

    const varType = this.parseTypeName();
    // Function or variable?
    const nameTok = this.expectIdent();
    // Class method defined out of line: Type Class::Method(...)
    if (this.is("::")) {
      this.next();
      this.expectIdent();
      while (!this.is("{") && !this.is(";") && this.peek().kind !== "eof") this.next();
      if (this.is("{")) this.skipBraces();
      return [{ type: "Unsupported", what: `class method ${nameTok.value}::...`, line: start.line }];
    }
    if (this.is("(")) {
      const params = this.parseParams();
      while (this.is("const") || this.is("override")) this.next();
      if (this.eat(";")) return []; // prototype
      const body = this.parseBlock();
      const fn: FuncDecl = { type: "FuncDecl", returnType: varType, name: nameTok.value, params, body, line: start.line };
      return [fn];
    }
    const decl = this.finishVarDecl(modifiers, varType, nameTok, start.line);
    return [decl];
  }

  private parseEnum(): EnumDecl {
    const start = this.expect("enum");
    const name = this.expectIdent().value;
    this.expect("{");
    const members: EnumDecl["members"] = [];
    while (!this.is("}")) {
      const m = this.expectIdent().value;
      let value: Expr | null = null;
      if (this.eat("=")) value = this.parseExpr();
      members.push({ name: m, value, comment: null });
      if (!this.eat(",")) break;
    }
    this.expect("}");
    this.eat(";");
    return { type: "EnumDecl", name, members, line: start.line };
  }

  /** Type names: built-ins or identifiers, optionally `unsigned int`, with trailing `*`/`&`. */
  private parseTypeName(): string {
    const t = this.expectIdent();
    let name = t.value;
    if (name === "unsigned" && this.peek().kind === "ident") name = "u" + this.next().value;
    // Generic types like CArrayObj<T> are not supported but keep parsing going.
    if (this.is("<") && this.peek(1).kind === "ident" && this.is(">", 2)) {
      this.next();
      name += "<" + this.next().value + ">";
      this.next();
    }
    while (this.is("*") || this.is("&")) this.next();
    return name;
  }

  private parseParams(): Param[] {
    this.expect("(");
    const params: Param[] = [];
    if (this.eat(")")) return params;
    if (this.is("void") && this.is(")", 1)) {
      this.next();
      this.next();
      return params;
    }
    do {
      while (this.is("const")) this.next();
      const varType = this.parseTypeName();
      let isRef = false;
      if (this.eat("&")) isRef = true;
      // parseTypeName already swallowed a trailing & (e.g. "double &arr[]")
      if (this.tokens[this.pos - 1]?.value === "&") isRef = true;
      const name = this.expectIdent().value;
      let isArray = false;
      while (this.eat("[")) {
        isArray = true;
        if (!this.is("]")) this.parseExpr();
        this.expect("]");
      }
      let defaultValue: Expr | null = null;
      if (this.eat("=")) defaultValue = this.parseAssign();
      params.push({ varType, name, isRef, isArray, defaultValue });
    } while (this.eat(","));
    this.expect(")");
    return params;
  }

  private finishVarDecl(modifiers: string[], varType: string, firstName: Token, line: number): VarDecl {
    const declarators: Declarator[] = [];
    let nameTok: Token | null = firstName;
    for (;;) {
      const name = nameTok ? nameTok.value : this.expectIdent().value;
      nameTok = null;
      let arraySize: Expr | null = null;
      let isArray = false;
      while (this.eat("[")) {
        isArray = true;
        if (!this.is("]")) arraySize = this.parseExpr();
        this.expect("]");
      }
      let init: Expr | null = null;
      let initList: Expr[] | null = null;
      if (this.eat("=")) {
        if (this.is("{")) {
          this.next();
          initList = [];
          while (!this.is("}")) {
            initList.push(this.parseAssign());
            if (!this.eat(",")) break;
          }
          this.expect("}");
        } else {
          init = this.parseAssign();
        }
      } else if (this.is("(")) {
        // Constructor-style init: CTrade trade(); or int x(5);
        this.next();
        const args: Expr[] = [];
        while (!this.is(")")) {
          args.push(this.parseAssign());
          if (!this.eat(",")) break;
        }
        this.expect(")");
        if (args.length === 1) init = args[0];
      }
      declarators.push({ name, arraySize, isArray, init, initList });
      if (!this.eat(",")) break;
    }
    this.expect(";");
    return { type: "VarDecl", modifiers, varType, declarators, line };
  }

  private parseBlock(): Stmt & { type: "Block" } {
    const start = this.expect("{");
    const body: Stmt[] = [];
    while (!this.is("}")) {
      if (this.peek().kind === "eof") throw new ParseError("Missing '}'", start.line);
      if (this.peek().kind === "directive") {
        this.next();
        continue;
      }
      body.push(this.parseStatement());
    }
    this.expect("}");
    return { type: "Block", body, line: start.line };
  }

  private looksLikeDecl(): boolean {
    let k = 0;
    while (this.peek(k).kind === "ident" && MODIFIERS.has(this.peek(k).value)) k++;
    const t = this.peek(k);
    if (t.kind !== "ident" || KEYWORDS.has(t.value)) return false;
    if (k > 0) return true; // modifiers always start a declaration
    let j = k + 1;
    if (t.value === "unsigned") j++;
    while (this.peek(j).kind === "op" && (this.peek(j).value === "*" || this.peek(j).value === "&")) j++;
    const n = this.peek(j);
    return n.kind === "ident" && !KEYWORDS.has(n.value);
  }

  private parseStatement(): Stmt {
    const t = this.peek();
    const line = t.line;

    if (this.is("{")) return this.parseBlock();
    if (this.eat(";")) return { type: "Empty", line };

    if (t.kind === "ident") {
      switch (t.value) {
        case "if": {
          this.next();
          this.expect("(");
          const test = this.parseExpr();
          this.expect(")");
          const then = this.parseStatement();
          const els = this.eat("else") ? this.parseStatement() : null;
          return { type: "If", test, then, else: els, line };
        }
        case "for": {
          this.next();
          this.expect("(");
          let init: Stmt | null = null;
          if (!this.is(";")) {
            if (this.looksLikeDecl()) {
              const modifiers: string[] = [];
              const varType = this.parseTypeName();
              init = this.finishVarDecl(modifiers, varType, this.expectIdent(), line);
            } else {
              init = { type: "ExprStmt", expr: this.parseExpr(), line };
              this.expect(";");
            }
          } else {
            this.expect(";");
          }
          const test = this.is(";") ? null : this.parseExpr();
          this.expect(";");
          const update: Expr[] = [];
          while (!this.is(")")) {
            update.push(this.parseAssign());
            if (!this.eat(",")) break;
          }
          this.expect(")");
          const body = this.parseStatement();
          return { type: "For", init, test, update, body, line };
        }
        case "while": {
          this.next();
          this.expect("(");
          const test = this.parseExpr();
          this.expect(")");
          return { type: "While", test, body: this.parseStatement(), line };
        }
        case "do": {
          this.next();
          const body = this.parseStatement();
          this.expect("while");
          this.expect("(");
          const test = this.parseExpr();
          this.expect(")");
          this.eat(";");
          return { type: "DoWhile", test, body, line };
        }
        case "return": {
          this.next();
          const value = this.is(";") ? null : this.parseExpr();
          this.expect(";");
          return { type: "Return", value, line };
        }
        case "break":
          this.next();
          this.expect(";");
          return { type: "Break", line };
        case "continue":
          this.next();
          this.expect(";");
          return { type: "Continue", line };
        case "switch":
          return this.parseSwitch();
      }
    }

    if (this.looksLikeDecl()) {
      const modifiers: string[] = [];
      while (this.peek().kind === "ident" && MODIFIERS.has(this.peek().value)) modifiers.push(this.next().value);
      const varType = this.parseTypeName();
      return this.finishVarDecl(modifiers, varType, this.expectIdent(), line);
    }

    const expr = this.parseExpr();
    this.expect(";");
    return { type: "ExprStmt", expr, line };
  }

  private parseSwitch(): Stmt {
    const line = this.expect("switch").line;
    this.expect("(");
    const test = this.parseExpr();
    this.expect(")");
    this.expect("{");
    const cases: SwitchCase[] = [];
    while (!this.is("}")) {
      let caseTest: Expr | null;
      if (this.eat("default")) {
        caseTest = null;
      } else {
        this.expect("case");
        caseTest = this.parseTernary();
      }
      this.expect(":");
      const body: Stmt[] = [];
      while (!this.is("case") && !this.is("default") && !this.is("}")) body.push(this.parseStatement());
      cases.push({ test: caseTest, body });
    }
    this.expect("}");
    return { type: "Switch", test, cases, line };
  }

  // ---- expressions ----

  parseExpr(): Expr {
    // The C comma operator is not supported; commas only separate arguments and declarators.
    return this.parseAssign();
  }

  private parseAssign(): Expr {
    const left = this.parseTernary();
    const t = this.peek();
    if (t.kind === "op" && ASSIGN_OPS.has(t.value)) {
      this.next();
      const value = this.parseAssign();
      return { type: "Assign", op: t.value, target: left, value, line: t.line };
    }
    return left;
  }

  private parseTernary(): Expr {
    const test = this.parseBinary(1);
    if (this.is("?")) {
      const line = this.next().line;
      const then = this.parseAssign();
      this.expect(":");
      const els = this.parseAssign();
      return { type: "Ternary", test, then, else: els, line };
    }
    return test;
  }

  private parseBinary(minPrec: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const prec = t.kind === "op" ? BINARY_PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      this.next();
      const right = this.parseBinary(prec + 1);
      left = { type: "Binary", op: t.value, left, right, line: t.line };
    }
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === "op" && ["!", "-", "+", "~", "++", "--"].includes(t.value)) {
      this.next();
      return { type: "Unary", op: t.value, arg: this.parseUnary(), prefix: true, line: t.line };
    }
    // Cast: (double)x
    if (this.is("(") && this.peek(1).kind === "ident" && BUILTIN_TYPES.has(this.peek(1).value) && this.is(")", 2)) {
      this.next();
      const to = this.next().value;
      this.next();
      return { type: "Cast", to, expr: this.parseUnary(), line: t.line };
    }
    if (this.is("new") || this.is("delete")) {
      throw new ParseError(`'${t.value}' (objects created at run time) is not supported`, t.line);
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(expr: Expr): Expr {
    for (;;) {
      const t = this.peek();
      if (this.is("(")) {
        this.next();
        const args: Expr[] = [];
        while (!this.is(")")) {
          args.push(this.parseAssign());
          if (!this.eat(",")) break;
        }
        this.expect(")");
        expr = { type: "Call", callee: expr, args, line: t.line };
      } else if (this.is("[")) {
        this.next();
        const index = this.parseExpr();
        this.expect("]");
        expr = { type: "Index", object: expr, index, line: t.line };
      } else if (this.is(".") || this.is("->")) {
        this.next();
        expr = { type: "Member", object: expr, property: this.expectIdent().value, line: t.line };
      } else if (this.is("::")) {
        this.next();
        expr = { type: "Member", object: expr, property: this.expectIdent().value, line: t.line };
      } else if (this.is("++") || this.is("--")) {
        this.next();
        expr = { type: "Unary", op: t.value, arg: expr, prefix: false, line: t.line };
      } else {
        return expr;
      }
    }
  }

  private parsePrimary(): Expr {
    const t = this.next();
    switch (t.kind) {
      case "number":
        return { type: "Number", value: t.value, isFloat: /[.eE]/.test(t.value) && !/^0[xX]/.test(t.value), line: t.line };
      case "string": {
        // Adjacent string literals concatenate.
        let value = t.value;
        while (this.peek().kind === "string") value += this.next().value;
        return { type: "String", value, line: t.line };
      }
      case "char":
        return { type: "Number", value: String(t.value.charCodeAt(0) || 0), isFloat: false, line: t.line };
      case "ident":
        if (t.value === "::") break;
        return { type: "Ident", name: t.value, line: t.line };
      case "op":
        if (t.value === "::") {
          return { type: "Ident", name: this.expectIdent().value, line: t.line };
        }
        break;
      case "punct":
        if (t.value === "(") {
          const e = this.parseExpr();
          this.expect(")");
          return e;
        }
        break;
    }
    throw new ParseError(`Unexpected '${t.value || t.kind}'`, t.line);
  }
}
