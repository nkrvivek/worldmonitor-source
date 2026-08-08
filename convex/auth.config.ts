// Supabase issues the tokens Convex trusts. The project is the same one
// sibt.ai uses, so an account works on both sites; entitlements do not carry
// across, because those live in Convex per product and Dodo billing writes
// them.
//
// `applicationID` is the JWT audience, and Supabase's is the fixed string
// "authenticated". It is not the app name and cannot be configured. Clerk's
// value here was "convex"; keeping it would leave every token failing
// audience validation while the client believed it was signed in.
const domain = process.env.SUPABASE_JWT_ISSUER;
if (!domain) throw new Error('SUPABASE_JWT_ISSUER is not set');

export default {
  providers: [
    {
      domain,
      applicationID: "authenticated",
    },
  ],
};
