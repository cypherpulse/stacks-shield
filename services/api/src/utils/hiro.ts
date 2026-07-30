// =============================================================================
// STX Shield API -- Hiro (Stacks) read-only client
// =============================================================================
// The API only ever READS the chain. It never signs or submits.

import { config } from "../config.js";

const headers = (): Record<string, string> => {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (config.hiroApiKey) h["x-api-key"] = config.hiroApiKey;
  return h;
};

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${config.hiroApiUrl}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`Hiro ${path} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
};

/** Current Stacks chain tip height. */
export const getTipHeight = async (): Promise<number> => {
  const info = await get<{ stacks_tip_height: number }>("/v2/info");
  return info.stacks_tip_height;
};

export interface ContractLogEvent {
  txId: string;
  eventIndex: number;
  /** Clarity value of the print, as hex (SIP-005 serialized). */
  valueHex: string;
}

/**
 * Page of a contract's smart-contract-log (print) events, newest first.
 * `limit` max 50 per Hiro.
 */
export const getContractEvents = async (
  contractId: string,
  limit: number,
  offset: number,
): Promise<ContractLogEvent[]> => {
  const body = await get<{
    results: Array<{
      event_index: number;
      tx_id: string;
      contract_log?: { value?: { hex?: string } };
    }>;
  }>(`/extended/v1/contract/${contractId}/events?limit=${limit}&offset=${offset}`);
  return body.results
    .filter((r) => r.contract_log?.value?.hex)
    .map((r) => ({ txId: r.tx_id, eventIndex: r.event_index, valueHex: r.contract_log!.value!.hex! }));
};

/** A confirmed transaction's status (used by the transactions route). */
export const getTx = async (
  txid: string,
): Promise<{ tx_status: string; block_height?: number; tx_type?: string } | null> => {
  try {
    return await get(`/extended/v1/tx/${txid.startsWith("0x") ? txid : "0x" + txid}`);
  } catch {
    return null;
  }
};

/** Read-only contract-call (clarity value hex result). */
export const callReadOnly = async (
  contractId: string,
  fn: string,
  args: string[] = [],
): Promise<string | null> => {
  const [addr, name] = contractId.split(".");
  const res = await fetch(`${config.hiroApiUrl}/v2/contracts/call-read/${addr}/${name}/${fn}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ sender: addr, arguments: args }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { okay: boolean; result?: string };
  return body.okay && body.result ? body.result : null;
};
