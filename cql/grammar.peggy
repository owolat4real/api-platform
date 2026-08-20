// CQL — CareerStudio Query Language grammar
//
// A small, pipe-based syntax: a noun opens a pipeline, verbs chain after it
// with `|`. Every step is `name(args)` — a positional string arg and/or
// `key: value` named args. `when(condition)` is the one guard form, where
// the sole positional argument is a comparison instead of a value.
//
// Deliberately excludes: variables, functions, loops, if/else, string
// interpolation, imports. A bare word used as a value (e.g. `job_id` in
// `match(job: job_id)`) parses as an Identifier node — this grammar does
// NOT resolve it to anything; that's an interpreter-level question, and an
// open one (see the AST/interpreter docs).

{
  // Left-fold a flat list of parsed steps into the brief's requested
  // linked-list shape: { name, positional, args, next }.
  function buildList(steps) {
    let next = null;
    for (let i = steps.length - 1; i >= 0; i--) {
      next = Object.assign({}, steps[i], { next });
    }
    return next;
  }
}

Start
  = _ q:Pipeline _ { return q; }

Pipeline
  = head:Step tail:(_ "|" _ s:Step { return s; })* {
      return buildList([head].concat(tail));
    }

Step
  = name:Identifier _ "(" _ args:ArgList? _ ")" {
      const positional = (args && args.positional) || null;
      const named      = (args && args.named) || {};
      return { name, positional, args: named };
    }

ArgList
  = first:Arg rest:(_ "," _ a:Arg { return a; })* {
      const all = [first].concat(rest);
      let positional = null;
      const named = {};
      for (const a of all) {
        if (a.key === null) {
          if (positional !== null) {
            error("only one positional argument is allowed per step");
          }
          positional = a.value;
        } else {
          named[a.key] = a.value;
        }
      }
      return { positional, named };
    }

Arg
  = key:Identifier _ ":" _ value:Value { return { key, value }; }
  / value:Value { return { key: null, value }; }

// A value is either a comparison (only meaningful inside when(...), but
// the grammar doesn't special-case which step it appears in — that's a
// semantic check, not a syntactic one), a string, a number, or a bare
// identifier reference.
Value
  = Condition
  / StringLiteral
  / NumberLiteral
  / name:Identifier { return { type: "identifier", name }; }

Condition
  = left:Identifier _ op:CompareOp _ right:(NumberLiteral / StringLiteral) {
      return { type: "condition", left, op, right };
    }

CompareOp
  = ">=" / "<=" / "==" / "!=" / ">" / "<"

StringLiteral
  = '"' chars:DoubleStringChar* '"' { return { type: "string", value: chars.join("") }; }

DoubleStringChar
  = "\\\"" { return "\""; }
  / "\\\\" { return "\\"; }
  / [^"]

NumberLiteral
  = digits:$([0-9]+ ("." [0-9]+)?) { return { type: "number", value: parseFloat(digits) }; }

Identifier
  = $([a-zA-Z_][a-zA-Z0-9_]*)

_ "whitespace"
  = (WhiteSpace / Comment)*

WhiteSpace
  = [ \t\n\r]

Comment
  = "//" [^\n]*
