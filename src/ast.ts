// AST for the MQL5 subset the converter understands.

export interface Loc {
  line: number;
}

export type Expr =
  | { type: "Number"; value: string; isFloat: boolean; line: number }
  | { type: "String"; value: string; line: number }
  | { type: "Ident"; name: string; line: number }
  | { type: "Call"; callee: Expr; args: Expr[]; line: number }
  | { type: "Member"; object: Expr; property: string; line: number }
  | { type: "Index"; object: Expr; index: Expr; line: number }
  | { type: "Unary"; op: string; arg: Expr; prefix: boolean; line: number }
  | { type: "Binary"; op: string; left: Expr; right: Expr; line: number }
  | { type: "Assign"; op: string; target: Expr; value: Expr; line: number }
  | { type: "Ternary"; test: Expr; then: Expr; else: Expr; line: number }
  | { type: "Cast"; to: string; expr: Expr; line: number };

export interface Declarator {
  name: string;
  arraySize: Expr | null; // null = not an array; Number 0 placeholder for "[]"
  isArray: boolean;
  init: Expr | null;
  initList: Expr[] | null; // for `int a[] = {1,2,3}`
}

export interface VarDecl {
  type: "VarDecl";
  modifiers: string[]; // static, const, input, sinput, extern
  varType: string;
  declarators: Declarator[];
  line: number;
}

export type Stmt =
  | VarDecl
  | { type: "Block"; body: Stmt[]; line: number }
  | { type: "ExprStmt"; expr: Expr; line: number }
  | { type: "If"; test: Expr; then: Stmt; else: Stmt | null; line: number }
  | { type: "For"; init: Stmt | null; test: Expr | null; update: Expr[]; body: Stmt; line: number }
  | { type: "While"; test: Expr; body: Stmt; line: number }
  | { type: "DoWhile"; test: Expr; body: Stmt; line: number }
  | { type: "Return"; value: Expr | null; line: number }
  | { type: "Break"; line: number }
  | { type: "Continue"; line: number }
  | { type: "Switch"; test: Expr; cases: SwitchCase[]; line: number }
  | { type: "Empty"; line: number };

export interface SwitchCase {
  test: Expr | null; // null = default
  body: Stmt[];
}

export interface Param {
  varType: string;
  name: string;
  isRef: boolean;
  isArray: boolean;
  defaultValue: Expr | null;
}

export interface FuncDecl {
  type: "FuncDecl";
  returnType: string;
  name: string;
  params: Param[];
  body: Stmt & { type: "Block" };
  line: number;
}

export interface EnumDecl {
  type: "EnumDecl";
  name: string;
  members: { name: string; value: Expr | null; comment: string | null }[];
  line: number;
}

export interface UnsupportedDecl {
  type: "Unsupported";
  what: string;
  line: number;
}

export type TopItem = VarDecl | FuncDecl | EnumDecl | UnsupportedDecl;

export interface Directive {
  text: string;
  line: number;
}

export interface Program {
  directives: Directive[];
  items: TopItem[];
}
