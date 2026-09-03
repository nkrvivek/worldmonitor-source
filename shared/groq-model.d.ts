// Type declarations for shared/groq-model.js.
//
// The Groq entry in every provider chain in this repo reads both of these.
// Callers spread GROQ_EXTRA_BODY into the request body rather than assigning
// it, so the frozen object is never mutated by a per-call override.

export declare const GROQ_FALLBACK_MODEL: string;

export declare const GROQ_EXTRA_BODY: Readonly<{ reasoning_effort: 'low' }>;
