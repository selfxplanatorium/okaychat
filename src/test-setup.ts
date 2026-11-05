// The suite must run on a clean checkout with no local .env. Tests that need storage create their own
// temporary data directory; this only supplies the encryption key that env.ts requires before any server
// module can load. It is imported by the test script, never by the application.
process.env.OKAYCHAT_SECRET ??= "okaychat-test-secret-not-for-production-32chars";
