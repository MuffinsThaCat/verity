export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * An error message can carry the address that was requested, and an RPC provider's key rides in that address (`?apiKey=...`,
 * or `user:pass@host`). Anything that prints or returns an error text, to a log or to a client, goes through this.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&;](?:api[_-]?key|apikey|access[_-]?token|token|key|secret|auth)=)[^&\s"'<>)]+/gi, "$1[hidden]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[hidden]@")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[hidden]");
}

export const log = (who: string, msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} [${who}] ${redactSecrets(msg)}`);
