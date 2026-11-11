import "dotenv/config";

export type Network = "testnet" | "mainnet";

export const NETWORK: Network = process.env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";

export const RPC_URL =
  process.env.NEAR_RPC_URL ??
  (NETWORK === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com");

export const VERITY_CONTRACT = process.env.VERITY_CONTRACT ?? "";

export interface Creds {
  accountId: string;
  privateKey: string;
}

export function creds(prefix: string): Creds {
  const accountId = process.env[`${prefix}_ACCOUNT_ID`];
  const privateKey = process.env[`${prefix}_PRIVATE_KEY`];
  if (!accountId || !privateKey) throw new Error(`Set ${prefix}_ACCOUNT_ID and ${prefix}_PRIVATE_KEY in .env`);
  return { accountId, privateKey };
}

export function requireContract(): string {
  if (!VERITY_CONTRACT) throw new Error("Set VERITY_CONTRACT in .env");
  return VERITY_CONTRACT;
}
