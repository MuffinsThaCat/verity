export type Side = "Yes" | "No";
export type Stance = "Support" | "Refute";
export type Rel = "Implies" | "Excludes";
export type BondState = "Open" | "Refunded" | "Forfeited";

export interface TradeRec {
  ts_ms: number;
  who: string;
  side: Side;
  buy: boolean;
  amount: string;
  price_bps: number;
  evidence: number | null;
}

export interface ClaimView {
  id: number;
  topic: string;
  text: string;
  creator: string;
  created_ms: number;
  price_bps: number;
  collateral: string;
  reserve_yes: string;
  reserve_no: string;
  volume: string;
  trades: number;
  fee_pool: string;
  evidence: number[];
  links: number[];
  link_id: number | null;
  tape: TradeRec[];
}

export interface Evidence {
  id: number;
  claim_id: number;
  author: string;
  stance: Stance;
  uri: string;
  content_hash: string;
  note: string;
  bond: string;
  backing: string;
  independent: string;
  posted_ms: number;
  price_at_post_bps: number;
  bond_state: BondState;
}

export interface Link {
  id: number;
  claim_id: number;
  a: number;
  b: number;
  rel: Rel;
  creator: string;
}

export interface Quote {
  out: string;
  fee: string;
  price_before_bps: number;
  price_after_bps: number;
}

export interface Violation {
  link_id: number;
  link_claim: number;
  rel: Rel;
  a: number;
  b: number;
  price_a_bps: number;
  price_b_bps: number;
  link_conf_bps: number;
  gap_bps: number;
  score: number;
}

export interface Accounting {
  total_in: string;
  total_out: string;
  liabilities: string;
  kept: string;
  /** Payouts that could not be delivered (a deleted account, say); already part of `kept`. */
  stranded: string;
}

export interface VerityConfig {
  fee_bps: number;
  bond_window_ms: number;
  claims: number;
  evidence: number;
  links: number;
}
