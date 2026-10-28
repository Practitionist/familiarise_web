import "@testing-library/jest-dom";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

// Suites send to example addresses; the pre-launch guard's own pin unsets this.
process.env.EMAIL_DELIVERY_MODE ??= "live";
