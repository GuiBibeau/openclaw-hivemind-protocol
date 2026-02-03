import { Keypair } from "@solana/web3.js";
import { readFile } from "fs/promises";
import { resolve } from "path";

export async function loadKeypair(path: string): Promise<Keypair> {
  const resolved = resolve(path);
  const raw = await readFile(resolved, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}
