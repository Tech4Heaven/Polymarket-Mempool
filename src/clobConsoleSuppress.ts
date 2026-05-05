/**
 * `@polymarket/clob-client-v2` logs every non-2xx via `console.error` (`[CLOB Client] request error`),
 * including the expected 400 on `create` when keys already exist. Hide that during wallet auth only.
 */
export async function withSuppressedPolymarketClobConsole<T>(
  fn: () => Promise<T>
): Promise<T> {
  const origErr = console.error.bind(console);
  const origLog = console.log.bind(console);
  const isClobNoise = (args: unknown[]): boolean => {
    const a0 = args[0];
    return (
      typeof a0 === "string" &&
      (a0.startsWith("[CLOB Client]") || a0.startsWith("[CLOB Client-v2]"))
    );
  };
  console.error = (...args: unknown[]) => {
    if (isClobNoise(args)) {
      return;
    }
    origErr(...(args as Parameters<typeof console.error>));
  };
  console.log = (...args: unknown[]) => {
    if (isClobNoise(args)) {
      return;
    }
    origLog(...(args as Parameters<typeof console.log>));
  };
  try {
    return await fn();
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
}
