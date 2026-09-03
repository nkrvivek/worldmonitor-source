// The Groq model id for every fallback path that ships inside `scripts/`.
//
// This duplicates `shared/groq-model.js` on purpose, and
// `tests/groq-model-single-source.test.mjs` pins the two equal. The nixpacks
// Railway build uses `root_dir=scripts`, so only `scripts/` reaches `/app/` in
// the container. A seed entry point that imported `../shared/groq-model.js`
// would resolve to `/shared/groq-model.js` at runtime and die on
// ERR_MODULE_NOT_FOUND (#3811, guarded by
// tests/scripts-railway-nixpacks-no-escape-import.test.mts). One id, two files,
// one test holding them together.
//
// Measured 2026-08-24: `llama-3.3-70b-versatile` and `llama-3.1-8b-instant`
// were both decommissioned and `GET https://api.groq.com/openai/v1/models` no
// longer lists either, so every groq fallback in this repo had been answering
// HTTP 404 for weeks. The key was fine the whole time; the models were gone.
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
