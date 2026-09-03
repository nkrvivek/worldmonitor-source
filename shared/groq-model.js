// Runtime surface for shared/groq-model.d.ts.
//
// Twin: scripts/lib/groq-model.mjs. The Railway nixpacks build ships
// `scripts/` alone as `/app/`, so a seed entry point cannot import this file
// without dying on ERR_MODULE_NOT_FOUND in the container (#3811). One id, two
// files, held equal by tests/groq-model-single-source.test.mjs.
//
// One name for the Groq model every fallback path uses, because the last
// change of model took six edits in five files and the test suite pinned the
// old id in fifteen more. Measured 2026-08-24: `llama-3.3-70b-versatile` was
// decommissioned and `GET https://api.groq.com/openai/v1/models` no longer
// lists it, so every groq fallback in this repo had been answering HTTP 404
// for weeks. The key was fine the whole time; the model was gone. That is why
// the id lives here and not inline at each call site.
//
// `openai/gpt-oss-120b` is a reasoning model. It returns its chain of thought
// in a separate `reasoning` field and clean JSON in `content`, but at default
// effort it can spend the whole `max_tokens` budget thinking and emit no
// content at all (measured: empty content at max_tokens 50). Several callers
// here run at maxTokens 300, so the low effort setting is not a tuning knob,
// it is what makes those callers work. Measured at low effort: 17 reasoning
// tokens, 274 completion tokens, finish_reason stop, parseable JSON.
//
// `qwen/qwen3.6-27b` was rejected on the same probe: it writes a literal
// <think> block into `content`, which fails every JSON validator downstream.

/** @type {string} */
export const GROQ_FALLBACK_MODEL = 'openai/gpt-oss-120b';

/** @type {{ reasoning_effort: 'low' }} */
export const GROQ_EXTRA_BODY = Object.freeze({ reasoning_effort: 'low' });
