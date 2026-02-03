import { Keypair } from "@solana/web3.js";
import { mkdir, writeFile } from "fs/promises";
import { dirname, resolve } from "path";

const outPath = resolve(Bun.env.AGENT_KEYPAIR_PATH ?? "./keys/agent.json");

const keypair = Keypair.generate();
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(Array.from(keypair.secretKey), null, 2), "utf8");

console.log(`Saved keypair to ${outPath}`);
console.log(`Public key: ${keypair.publicKey.toBase58()}`);
