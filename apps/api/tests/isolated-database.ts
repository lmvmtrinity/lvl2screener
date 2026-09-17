export function isolatedDatabaseUrl(
  key: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = environment[key];
  if (!value) {
    if (environment.REQUIRE_POSTGRES_INTEGRATION === "true") {
      throw new Error(`${key} must name an explicitly isolated test database`);
    }
    return undefined;
  }
  const parsed = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^tsx_scanner_test(?:_[a-z0-9_]+)?$/.test(
      decodeURIComponent(parsed.pathname.slice(1)),
    )
  ) {
    throw new Error(`${key} database name must start with tsx_scanner_test`);
  }
  if (environment.DATABASE_URL) {
    const application = new URL(environment.DATABASE_URL);
    if (
      application.hostname === parsed.hostname &&
      (application.port || "5432") === (parsed.port || "5432") &&
      application.pathname === parsed.pathname
    ) {
      throw new Error(`${key} must not target the application database`);
    }
  }
  return value;
}
