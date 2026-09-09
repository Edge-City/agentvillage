/** Credentials for the configured Index API origin. */
export interface IndexConnection {
  apiKey: string;
  apiUrl: string;
}

/** Invoke the matching CLI once, preserving JSON failures without replaying writes. */
export async function callIndex<T>(connection: IndexConnection, args: string[]): Promise<T> {
  const child = Bun.spawn(["index", "--api-url", connection.apiUrl, ...args, "--json"], {
    env: { ...process.env, INDEX_API_KEY: connection.apiKey, INDEX_SESSION_TOKEN: "" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const payload = JSON.parse(stdout);
  if (code !== 0) throw new Error(JSON.stringify(payload));
  return payload as T;
}
