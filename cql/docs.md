# CQL — CareerStudio Query Language

CQL is a small, declarative, pipe-based syntax for chaining CareerStudioMax
Developer Cloud operations in one line instead of several imperative SDK
calls. It's not a general-purpose language — no loops, no user-defined
functions, no standalone runtime. Every query parses to an AST and compiles
directly into real calls against the same `/v1/career/*` REST API the
JavaScript and Python SDKs already use.

**CQL is optional.** Most developers building an app will still want a
language-native client library — that's what the SDKs are for. Reach for
CQL when you want to express a multi-step workflow (score → conditionally
generate → whatever's next) as one readable line, in a script, a notebook,
or anywhere calling a single endpoint isn't the natural shape of the
problem.

## Quickstart

```bash
curl -X POST https://careerlm-api.careerstudiomax.com/v1/cql/execute \
  -H "X-Api-Key: csk_free_v1_..." \
  -H "Content-Type: application/json" \
  -d '{"query": "cv(\"...\") | score(job: \"...\") | when(ats_score > 75) | cover_letter(mode: \"achievement-led\")"}'
```

Every step in a pipeline is a real request against your account's usual
tier limits and rate limits — a 3-step query costs 3 requests, the same as
calling those 3 endpoints yourself. There's no discount or bypass for going
through CQL, and no extra cost either.

## Example queries

**Score a CV, then conditionally write a cover letter:**

```cql
cv("Ada Okonkwo, Senior Engineer, 8 years React/Node...")
  | score(job: "Senior Product Manager, fintech, 5+ years")
  | when(ats_score > 75)
  | cover_letter(mode: "achievement-led")
```

`when(...)` is a guard, not a branch — if the condition is false, the
pipeline stops there and returns immediately with `status: "stopped"`,
along with whatever context the earlier steps produced. It's not an error;
`cover_letter` (which costs real tokens) simply never runs.

**Salary benchmark, one line:**

```cql
salary("Data Engineer", country: "NG", city: "Lagos", currency: "NGN")
```

## Grammar

- **Nouns** open a pipeline: `cv(...)`, `salary(...)`. A noun can only be
  the first step.
- **Pipe** `|` chains a step's output into the next step's input.
- **Verbs** — `score`, `optimise`, `cover_letter`, `interview_questions`,
  `skills_gap` — each maps to one existing `/v1/career/*` endpoint.
- **`when(condition)`** — the one guard form. `condition` is
  `identifier <op> value`, where `<op>` is one of `> < >= <= == !=`.
- **Named arguments** — `key: value` pairs, mapping directly to the
  underlying endpoint's real parameters.
- Comments start with `//` and run to end of line. Newlines and
  indentation inside a pipeline are not significant.

**Deliberately excluded**, this phase: variables, user-defined functions,
loops, if/else branching, string interpolation, imports. A bare (unquoted)
word used as a value — e.g. `job: some_var` — is a semantic error, not a
variable reference: CQL has nothing to resolve it to, so it fails loudly
rather than guessing.

## Errors

Every response distinguishes which of three things went wrong:

| `error.kind` | Meaning | Example |
|---|---|---|
| `syntax_error` | The query itself doesn't parse. Includes `location` (line/column). | a dangling `job: )` with no value |
| `semantic_error` | The query parses, but references something CQL doesn't know — an unrecognised verb, a missing required argument, a bare identifier. | `graph()` — not part of this phase's vocabulary |
| `upstream_error` | The query was valid CQL, but the real endpoint it called returned an error — a bad request, a tier restriction, a content-policy block. Carries the underlying `code` and HTTP `status`. | `cover_letter` on a Free-tier key (needs Starter+) |

## Current scope (Phase 1)

This build intentionally covers a subset of what a full "query the whole
CareerStudioMax surface" language might eventually support:

- **Targets api-platform only.** Every verb maps to this product's own
  `/v1/career/*` endpoints. It does not reach into other CareerStudioMax
  products (e.g. the Transformer API), which run on separate
  infrastructure with separate authentication.
- **`match` (job matching)** isn't implemented yet — the real endpoint
  needs structured `candidate`/`job` objects that don't fit cleanly into
  CQL's simple noun-and-named-argument model without adding object-literal
  syntax, which is a bigger addition than this phase scoped.
- **`chat` and `context`** (the OpenAI-compatible chat endpoint and
  persistent career-context memory) aren't wired into CQL yet — they don't
  fit the "score → act on the result" pipeline shape the initial verb set
  was built around.

None of these are permanently out of scope — they're candidates for a
future increment, each evaluated on its own rather than bundled in here.
