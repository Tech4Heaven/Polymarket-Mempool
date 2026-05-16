import * as readline from "node:readline/promises";

const ENV_PASS = "COPY_WALLET_KEY_PASSPHRASE";

export async function promptWalletPassphraseForDecrypt(): Promise<string> {
  const fromEnv = process.env[ENV_PASS]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Set ${ENV_PASS} in the environment, or run in an interactive terminal to enter the passphrase.`
    );
  }
  return readPassphraseHidden("Passphrase");
}

export function readPassphraseHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
    const stdout = process.stdout;
    stdout.write(`${prompt}: `);
    const canRaw = typeof stdin.setRawMode === "function";
    if (canRaw) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r") {
          cleanup();
          stdout.write("\n");
          resolve(buf);
          return;
        }
        if (code === 3) {
          cleanup();
          stdout.write("\n");
          reject(new Error("Interrupted (Ctrl+C)"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (canRaw) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}
