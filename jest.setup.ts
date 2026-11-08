import "@testing-library/jest-dom";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
// Signed links derive their key from the auth secret; suites that need it unset delete it.
process.env.BETTER_AUTH_SECRET ??= "jest-auth-secret-0123456789abcdef";

// Suites send to example addresses; the pre-launch guard's own pin unsets this.
process.env.EMAIL_DELIVERY_MODE ??= "live";
