import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const encoder = new TextEncoder();

export function signMessage(message: string, keypair: Keypair): string {
  const msgBytes = encoder.encode(message);
  const signature = nacl.sign.detached(msgBytes, keypair.secretKey);
  return Buffer.from(signature).toString("base64");
}

export function verifyMessage(message: string, signature: string, pubkey: string): boolean {
  const msgBytes = encoder.encode(message);
  let sigBytes: Uint8Array;
  let pubkeyBytes: Uint8Array;
  try {
    sigBytes = Buffer.from(signature, "base64");
    pubkeyBytes = bs58.decode(pubkey);
  } catch {
    return false;
  }
  if (pubkeyBytes.length !== nacl.sign.publicKeyLength) return false;
  if (sigBytes.length !== nacl.sign.detached.signatureLength) return false;
  return nacl.sign.detached.verify(msgBytes, sigBytes, pubkeyBytes);
}

export function verifyEd25519Base64(
  message: string,
  signatureBase64: string,
  publicKeyBase64: string
): boolean {
  const msgBytes = encoder.encode(message);
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;

  try {
    sigBytes = Buffer.from(signatureBase64, "base64");
    pubBytes = Buffer.from(publicKeyBase64, "base64");
  } catch {
    return false;
  }

  if (sigBytes.length !== nacl.sign.detached.signatureLength) return false;
  if (pubBytes.length !== nacl.sign.publicKeyLength) return false;
  return nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
}

export function isValidSolanaPublicKey(pubkey: string): boolean {
  try {
    const bytes = bs58.decode(pubkey);
    return bytes.length === nacl.sign.publicKeyLength;
  } catch {
    return false;
  }
}
