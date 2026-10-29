# How the fact check works

The goal: no claim in a published article that the engine could not verify against a source it read.

## Inputs

`QualityInput` (`packages/engine/src/lib/quality/types.ts`): the article (title, Markdown body, FAQ), the saved source texts (URL and the exact text that was read), optional voice notes, banned claims, and the hosts that count as the customer's own site.

## Step 1: rule checks

Pure code, no model. Run by `ruleChecks()` in `packages/engine/src/lib/quality/index.ts`.

- A number in a cited sentence must appear in the source it links (formatting differences like `45%` and `45 percent` are handled).
- A number with no link must be a shown calculation, a labeled example, or already cited elsewhere in the article.
- A link must point at a source that was read. A link to anything else is a block.
- A source that sells something related must be disclosed near where it is cited.
- Banned claims and words to avoid are matched exactly. Em dashes and hype phrases are style flags.

## Step 2: the judge

For each cited sentence the engine selects the source passages that overlap it most and asks a `Judge` for one of `supported`, `partly_supported` or `not_supported`.

| Judge | Needs | Notes |
|---|---|---|
| `RuleJudge` | nothing | Scores the share of the sentence's key words found in the passages. Deterministic and free. It cannot judge voice or opinion, so it reports nothing there instead of guessing. |
| `FastModelJudge` | `ANTHROPIC_API_KEY` | A small Claude model with generic prompts. |
| `HostedVerifier` | `PAPERBOY_API_KEY` | One call to `POST /api/v1/verify` on the hosted service, which runs the tuned verifier. |

## Step 3: the verdict

`Verdict { pass, score, summary, judge, checks[] }`. A check passes unless it holds a `block` issue. The article passes with no block and a score of at least 70. The UI language is **VERIFIED** and **HELD**.

On a hold the pipeline builds a fix list (`fixList()`), asks the writer for one rewrite, and checks again. Still failing means `needs_review`, never published.

## Plugging in your own

```ts
import { registerVerifier } from "@/lib/quality";
registerVerifier((budget) => ({ id: "mine", verify: async (input) => /* your Verdict */ }));
```

Register once at startup. The pipeline never knows which verifier it got.
