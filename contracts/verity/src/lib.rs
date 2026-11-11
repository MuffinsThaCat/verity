//! Verity: perpetual belief markets.
//!
//! Every claim in the encyclopedia is a binary market that never resolves. Its price is the crowd's current
//! confidence that the claim is true. There is no oracle and no end date: traders and agents can always enter or
//! leave against the pool, so the price floats as evidence accumulates.
//!
//! What the contract provides:
//!
//! 1. **Claim markets.** A fixed-product AMM over YES and NO shares, integer-only (NEAR's VM rejects floats).
//!    The pool is always fully collateralised: `collateral == YES supply == NO supply`, checked on every trade.
//! 2. **Evidence.** Anyone may attach a source (URL + sha256 of the fetched content) to a claim with a stance,
//!    backed by a bond. Trades may cite a piece of evidence, and the capital behind those trades is its
//!    "backing". An author whose evidence has at least the bond's worth of capital behind it (their own
//!    included: they are putting money where their source is) gets the bond back, otherwise it is forfeited to the
//!    claim's fee pool. `independent` counts only other accounts' capital and is what the UI ranks evidence by.
//! 3. **Links.** A relation between two claims ("A implies B", "A excludes B") is itself a claim market, so the
//!    crowd prices whether the relation holds. `get_violations` lists links whose two sides are priced
//!    inconsistently, weighted by how much the crowd believes the link. This is what makes contradictions
//!    visible and tradeable.
//!
//! Honest limit: because nothing resolves, a contradiction trade is a convergence trade, not a risk-free
//! arbitrage. Its profit depends on other participants moving the prices together. See DESIGN.md.
//!
//! Units: internal accounting is in "ticks" of 1e12 yocto (1e-12 NEAR) so that products of reserves fit u128.
//! Everything crossing the API is in yocto. Share counts are reported in yocto-equivalent as well: a complete
//! YES+NO set is always redeemable for the same amount of NEAR.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseResult};

const TICK: u128 = 1_000_000_000_000;
const BPS: u128 = 10_000;

/// Smallest seed that opens a market: 0.5 NEAR.
const MIN_SEED_Y: u128 = 500_000_000_000_000_000_000_000;
/// Kept by the contract to pay for the claim's storage (about 5 KB at its largest): 0.07 NEAR.
const CLAIM_FEE_Y: u128 = 70_000_000_000_000_000_000_000;
/// Kept by the contract the first time an account trades a claim: 0.002 NEAR.
const POSITION_FEE_Y: u128 = 2_000_000_000_000_000_000_000;
/// Smallest buy: 0.01 NEAR.
const MIN_TRADE_Y: u128 = 10_000_000_000_000_000_000_000;
/// Kept by the contract for each piece of evidence (storage): 0.01 NEAR.
const EVIDENCE_FEE_Y: u128 = 10_000_000_000_000_000_000_000;
/// Smallest evidence bond: 0.02 NEAR.
const MIN_BOND_Y: u128 = 20_000_000_000_000_000_000_000;
/// Per-claim cap on collateral so reserve products stay inside u128: 100,000 NEAR.
const MAX_COLLATERAL_TICKS: u128 = 100_000_000_000_000_000;

const MAX_FEE_BPS: u16 = 300;
const MIN_PRIOR_BPS: u16 = 500;
const MAX_PRIOR_BPS: u16 = 9_500;
const TAPE_CAP: usize = 48;
const MAX_EVIDENCE_PER_CLAIM: usize = 64;
/// One account cannot take more than this many of a claim's evidence slots.
const MAX_EVIDENCE_PER_AUTHOR: usize = 8;
/// Each piece of evidence already on a claim adds a 1/8 of the storage fee to the cost of the next one (paid into the
/// claim's fee pool), so filling a claim's slots to lock honest sources out costs more with every slot.
const EVIDENCE_SURCHARGE_STEPS: u128 = 8;
/// Every contradiction a visitor injects adds a link to the true claim it contradicts, so this has to leave room for a demo
/// being replayed; the test `a_claim_at_every_limit_still_fits_in_what_the_claim_fee_pays_for` checks the claim fee still pays for it.
const MAX_LINKS_PER_CLAIM: usize = 64;
/// Keeps `get_claims_by_topic` inside the view gas limit.
const MAX_CLAIMS_PER_TOPIC: usize = 60;
const MAX_TEXT: usize = 280;
const MAX_URI: usize = 300;
const MAX_TOPIC: usize = 64;
/// How many links one `get_violations` call looks at. A link costs four storage reads (the link and its three claims), and a read of
/// a key nothing else in the call has read costs about 0.25 Tgas whatever its size. Measured on a node with 40 links over 80
/// different full-tape claims: 1.0 Tgas a link, so 64 links is about 65 Tgas against the 200 a view call may use (200 links
/// would have been 202). Older links are reached by passing `before`.
const MAX_VIOLATION_SCAN: u64 = 64;
const LINK_TOPIC: &str = "meta:links";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Claims,
    Evidence,
    Links,
    Positions,
    Topics,
    TopicList,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Yes,
    No,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stance {
    Support,
    Refute,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rel {
    /// A implies B: a consistent market has price(A) <= price(B).
    Implies,
    /// A and B cannot both be true: a consistent market has price(A) + price(B) <= 1.
    Excludes,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BondState {
    Open,
    Refunded,
    Forfeited,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TradeRec {
    pub ts_ms: u64,
    pub who: AccountId,
    pub side: Side,
    pub buy: bool,
    /// Gross NEAR (yocto) paid in, or gross proceeds paid out before fee.
    pub amount: U128,
    /// Price of YES in basis points after this trade.
    pub price_bps: u16,
    pub evidence: Option<u64>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Claim {
    id: u64,
    topic: String,
    text: String,
    creator: AccountId,
    created_ms: u64,
    r_yes: u128,
    r_no: u128,
    collateral: u128,
    user_yes: u128,
    user_no: u128,
    volume: u128,
    trades: u64,
    fee_pool_y: u128,
    evidence: Vec<u64>,
    links: Vec<u64>,
    link_id: Option<u64>,
    tape: Vec<TradeRec>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Evidence {
    pub id: u64,
    pub claim_id: u64,
    pub author: AccountId,
    pub stance: Stance,
    pub uri: String,
    /// sha256 (lowercase hex) of the content the author fetched from `uri`. Anyone can re-fetch and compare.
    pub content_hash: String,
    pub note: String,
    pub bond: U128,
    /// Capital (yocto) behind trades that cited this evidence, the author's included. It keeps counting after the bond has
    /// settled (the capital is real, and the UI ranks by it); only what had accumulated when the window closed decided the bond.
    pub backing: U128,
    /// The part of `backing` that came from accounts other than the author.
    pub independent: U128,
    pub posted_ms: u64,
    pub price_at_post_bps: u16,
    pub bond_state: BondState,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Link {
    pub id: u64,
    /// The claim whose market prices "this relation holds".
    pub claim_id: u64,
    pub a: u64,
    pub b: u64,
    pub rel: Rel,
    pub creator: AccountId,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default)]
struct Position {
    yes: u128,
    no: u128,
}

#[near(serializers = [json])]
pub struct ClaimView {
    pub id: u64,
    pub topic: String,
    pub text: String,
    pub creator: AccountId,
    pub created_ms: u64,
    pub price_bps: u16,
    pub collateral: U128,
    pub reserve_yes: U128,
    pub reserve_no: U128,
    pub volume: U128,
    pub trades: u64,
    pub fee_pool: U128,
    pub evidence: Vec<u64>,
    pub links: Vec<u64>,
    /// Set when this claim is the market for a link relation.
    pub link_id: Option<u64>,
    pub tape: Vec<TradeRec>,
}

#[near(serializers = [json])]
pub struct PositionView {
    pub yes: U128,
    pub no: U128,
}

#[near(serializers = [json])]
pub struct QuoteView {
    /// Shares received (buy) or NEAR received after fee (sell), in yocto.
    pub out: U128,
    pub fee: U128,
    pub price_before_bps: u16,
    pub price_after_bps: u16,
}

#[near(serializers = [json])]
pub struct Violation {
    pub link_id: u64,
    pub link_claim: u64,
    pub rel: Rel,
    pub a: u64,
    pub b: u64,
    pub price_a_bps: u16,
    pub price_b_bps: u16,
    /// How strongly the crowd believes the relation (price of the link claim).
    pub link_conf_bps: u16,
    /// Size of the inconsistency in basis points.
    pub gap_bps: u16,
    /// gap * confidence, basis points squared / 10000. Violations are sorted by this.
    pub score: u32,
}

#[near(serializers = [json])]
pub struct Accounting {
    pub total_in: U128,
    pub total_out: U128,
    /// Collateral + unpaid fees + open bonds: what the contract owes.
    pub liabilities: U128,
    /// Storage fees and rounding dust the contract keeps (stranded payouts included).
    pub kept: U128,
    /// Payouts that could not be delivered, for example to an account that has since been deleted. They are part of
    /// `kept`; this says how much of it is money somebody was owed.
    pub stranded: U128,
}

#[near(serializers = [json])]
pub struct Config {
    pub fee_bps: u16,
    pub bond_window_ms: u64,
    pub claims: u64,
    pub evidence: u64,
    pub links: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Verity {
    claims: Vector<Claim>,
    evidence: Vector<Evidence>,
    links: Vector<Link>,
    positions: LookupMap<(u64, AccountId), Position>,
    topics: LookupMap<String, Vec<u64>>,
    topic_list: Vector<String>,
    bond_window_ms: u64,
    fee_bps: u16,
    total_in: u128,
    total_out: u128,
    kept: u128,
    /// Payouts whose transfer failed (already counted in `kept`).
    stranded: u128,
    /// Collateral + unpaid fees + open bonds, maintained incrementally so the audit view costs O(1).
    liabilities: u128,
}

// ── pure math ──────────────────────────────────────────────────────────────────────────────────────────

fn t2y(t: u128) -> u128 {
    t.checked_mul(TICK).unwrap_or_else(|| env::panic_str("amount overflow"))
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a / b + u128::from(a % b != 0)
}

fn isqrt_ceil(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = x / 2 + 1;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    if x * x < n {
        x + 1
    } else {
        x
    }
}

fn price_bps(r_yes: u128, r_no: u128) -> u16 {
    let tot = r_yes + r_no;
    ((r_no * BPS / tot).clamp(1, BPS - 1)) as u16
}

struct BuyCalc {
    fee: u128,
    net: u128,
    shares: u128,
    r_yes: u128,
    r_no: u128,
}

/// Pure buy math in ticks. Fixed product: the bought side's reserve shrinks so that `r_yes * r_no` never drops.
fn buy_calc(r_yes: u128, r_no: u128, side: Side, amount: u128, fee_bps: u16) -> Result<BuyCalc, &'static str> {
    let fee = amount * u128::from(fee_bps) / BPS;
    let net = amount - fee;
    if net == 0 {
        return Err("amount too small");
    }
    let (r_b, r_o) = if side == Side::Yes { (r_yes, r_no) } else { (r_no, r_yes) };
    let k = r_b.checked_mul(r_o).ok_or("trade too large")?;
    let new_o = r_o + net;
    let new_b = ceil_div(k, new_o);
    let shares = (r_b + net).checked_sub(new_b).ok_or("pool arithmetic")?;
    if shares == 0 {
        return Err("amount too small");
    }
    let (r_yes, r_no) = if side == Side::Yes { (new_b, new_o) } else { (new_o, new_b) };
    Ok(BuyCalc { fee, net, shares, r_yes, r_no })
}

struct SellCalc {
    /// Collateral released from the pool before fee.
    gross: u128,
    fee: u128,
    r_yes: u128,
    r_no: u128,
}

/// Pure sell math in ticks. Solves `(r_x + s - g)(r_o - g) = k` for the released collateral `g`, rounding in the
/// pool's favour.
fn sell_calc(r_yes: u128, r_no: u128, side: Side, shares: u128, fee_bps: u16) -> Result<SellCalc, &'static str> {
    if shares == 0 {
        return Err("nothing to sell");
    }
    let (r_x, r_o) = if side == Side::Yes { (r_yes, r_no) } else { (r_no, r_yes) };
    let k = r_x.checked_mul(r_o).ok_or("trade too large")?;
    let a = r_x.checked_add(shares).ok_or("trade too large")?;
    let b = r_o;
    let diff = a.abs_diff(b);
    let d = diff.checked_mul(diff).and_then(|v| v.checked_add(k.checked_mul(4)?)).ok_or("trade too large")?;
    let sq = isqrt_ceil(d);
    let gross = (a + b).saturating_sub(sq) / 2;
    if gross == 0 {
        return Err("amount too small");
    }
    if gross >= b || gross >= a {
        return Err("pool arithmetic");
    }
    let new_x = a - gross;
    let new_o = b - gross;
    if new_x.checked_mul(new_o).ok_or("trade too large")? < k {
        return Err("pool arithmetic");
    }
    let fee = gross * u128::from(fee_bps) / BPS;
    let (r_yes, r_no) = if side == Side::Yes { (new_x, new_o) } else { (new_o, new_x) };
    Ok(SellCalc { gross, fee, r_yes, r_no })
}

fn valid_topic(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_TOPIC && s.bytes().all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b':' | b'/'))
}

/// `min` counts characters, `max` counts bytes: storage is paid for by the byte, and the fees above are sized for it.
fn valid_text(s: &str, min: usize, max: usize) -> bool {
    s.chars().count() >= min && s.len() <= max && !s.chars().any(|c| c.is_control())
}

fn valid_uri(s: &str) -> bool {
    s.len() <= MAX_URI
        && (s.starts_with("https://") || s.starts_with("http://") || s.starts_with("ipfs://"))
        && !s.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn valid_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

// ── contract ───────────────────────────────────────────────────────────────────────────────────────────

#[near]
impl Verity {
    #[init]
    pub fn new(bond_window_secs: u64, fee_bps: u16) -> Self {
        require!(fee_bps <= MAX_FEE_BPS, "fee too high");
        require!(bond_window_secs >= 1 && bond_window_secs <= 30 * 86_400, "bond window out of range");
        Self {
            claims: Vector::new(Key::Claims),
            evidence: Vector::new(Key::Evidence),
            links: Vector::new(Key::Links),
            positions: LookupMap::new(Key::Positions),
            topics: LookupMap::new(Key::Topics),
            topic_list: Vector::new(Key::TopicList),
            bond_window_ms: bond_window_secs * 1_000,
            fee_bps,
            total_in: 0,
            total_out: 0,
            kept: 0,
            stranded: 0,
            liabilities: 0,
        }
    }

    // ── writes ─────────────────────────────────────────────

    /// Open a market for a claim. The attached deposit pays the storage fee and seeds the pool. `prior_bps` is the
    /// opening price of YES (5% to 95%): the creator receives the shares needed to make the pool open there.
    #[payable]
    pub fn create_claim(&mut self, topic: String, text: String, prior_bps: u16) -> u64 {
        require!(valid_topic(&topic), "topic must be 1-64 chars of a-z 0-9 - _ : /");
        require!(topic != LINK_TOPIC, "reserved topic");
        require!(valid_text(&text, 8, MAX_TEXT), "claim text must be 8 or more characters and at most 280 bytes, no control characters");
        let deposit = env::attached_deposit().as_yoctonear();
        self.total_in += deposit;
        self.open_market(topic, text, prior_bps, deposit, None)
    }

    /// Open a market for a relation between two existing claims. Everyone can then trade on whether the relation
    /// holds, and `get_violations` weighs inconsistencies by that price.
    #[payable]
    pub fn create_link(&mut self, a: u64, b: u64, rel: Rel, prior_bps: u16) -> u64 {
        require!(a != b, "a claim cannot link to itself");
        let ca = self.claim(a);
        let cb = self.claim(b);
        require!(ca.link_id.is_none() && cb.link_id.is_none(), "links connect ordinary claims, not other links");
        require!(ca.links.len() < MAX_LINKS_PER_CLAIM && cb.links.len() < MAX_LINKS_PER_CLAIM, "too many links on a claim");
        for lid in &ca.links {
            let l = self.links.get(*lid as u32).unwrap();
            // "A excludes B" and "B excludes A" are the same statement; "A implies B" and "B implies A" are not.
            let same = l.rel == rel && ((l.a == a && l.b == b) || (rel == Rel::Excludes && l.a == b && l.b == a));
            require!(!same, "link already exists");
        }
        let deposit = env::attached_deposit().as_yoctonear();
        self.total_in += deposit;
        let link_id = u64::from(self.links.len());
        let text = match rel {
            Rel::Implies => format!("#{a} implies #{b}"),
            Rel::Excludes => format!("#{a} and #{b} cannot both be true"),
        };
        let claim_id = self.open_market(LINK_TOPIC.to_string(), text, prior_bps, deposit, Some(link_id));
        self.links.push(Link { id: link_id, claim_id, a, b, rel, creator: env::predecessor_account_id() });
        for id in [a, b] {
            let mut c = self.claim(id);
            c.links.push(link_id);
            self.save(c);
        }
        log!("EVENT_JSON:{}", json!({"standard":"verity","version":"1.0.0","event":"link","data":{"link_id":link_id,"claim_id":claim_id,"a":a,"b":b,"rel":rel}}));
        claim_id
    }

    /// Attach a source to a claim. The deposit is a non-refundable storage fee, a surcharge that grows with the number of
    /// pieces already attached (it goes to the claim's fee pool), and a bond that is returned (via `settle_bond`) only if
    /// capital follows the evidence. One account may hold at most 8 of a claim's 64 slots, and a full claim makes room by
    /// dropping evidence whose bond was forfeited (nobody ever backed it).
    #[payable]
    pub fn post_evidence(&mut self, claim_id: u64, stance: Stance, uri: String, content_hash: String, note: String) -> u64 {
        let mut c = self.claim(claim_id);
        require!(c.link_id.is_none(), "evidence attaches to ordinary claims; trade a link claim directly");
        require!(valid_uri(&uri), "uri must be http(s):// or ipfs:// with no spaces, at most 300 chars");
        require!(valid_hash(&content_hash), "content_hash must be 64 lowercase hex chars (sha256)");
        require!(valid_text(&note, 0, MAX_TEXT), "note must be at most 280 bytes, no control characters");
        let author = env::predecessor_account_id();
        let mine = c.evidence.iter().filter(|e| self.evidence.get(**e as u32).map_or(false, |x| x.author == author)).count();
        require!(mine < MAX_EVIDENCE_PER_AUTHOR, "you have already posted the maximum evidence on this claim");
        let count = c.evidence.len() as u128;
        if c.evidence.len() >= MAX_EVIDENCE_PER_CLAIM {
            let stale = c.evidence.iter().position(|e| self.evidence.get(*e as u32).map_or(false, |x| x.bond_state == BondState::Forfeited));
            match stale {
                Some(i) => {
                    c.evidence.remove(i);
                }
                None => env::panic_str("claim already has the maximum evidence"),
            }
        }
        let surcharge = EVIDENCE_FEE_Y * count / EVIDENCE_SURCHARGE_STEPS;
        let deposit = env::attached_deposit().as_yoctonear();
        let need = EVIDENCE_FEE_Y + surcharge + MIN_BOND_Y;
        if deposit < need {
            env::panic_str(&format!("attach at least {need} yoctoNEAR: the 0.01 NEAR fee, {surcharge} for the {count} pieces already attached, and a bond of at least 0.02 NEAR"));
        }
        self.total_in += deposit;
        self.kept += EVIDENCE_FEE_Y;
        c.fee_pool_y += surcharge;
        self.liabilities += deposit - EVIDENCE_FEE_Y;
        let id = u64::from(self.evidence.len());
        let ev = Evidence {
            id,
            claim_id,
            author,
            stance,
            uri,
            content_hash,
            note,
            bond: U128(deposit - EVIDENCE_FEE_Y - surcharge),
            backing: U128(0),
            independent: U128(0),
            posted_ms: env::block_timestamp_ms(),
            price_at_post_bps: price_bps(c.r_yes, c.r_no),
            bond_state: BondState::Open,
        };
        c.evidence.push(id);
        self.evidence.push(ev);
        self.save(c);
        log!("EVENT_JSON:{}", json!({"standard":"verity","version":"1.0.0","event":"evidence","data":{"id":id,"claim_id":claim_id,"stance":stance}}));
        id
    }

    /// Buy YES or NO shares with the attached deposit. Optionally cite evidence whose stance matches the side
    /// (Support with YES, Refute with NO); your capital then counts as backing for it, the author's included (`independent` excludes the author's).
    /// Returns shares received (yocto-equivalent).
    #[payable]
    pub fn buy(&mut self, claim_id: u64, side: Side, min_shares: U128, evidence_id: Option<u64>) -> U128 {
        let who = env::predecessor_account_id();
        let mut c = self.claim(claim_id);
        let mut deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= MIN_TRADE_Y, "minimum trade is 0.01 NEAR");
        self.total_in += deposit;

        let key = (claim_id, who.clone());
        let mut pos = self.positions.get(&key).copied();
        if pos.is_none() {
            require!(deposit > POSITION_FEE_Y, "deposit too small to open a position");
            deposit -= POSITION_FEE_Y;
            self.kept += POSITION_FEE_Y;
        }
        let ticks = deposit / TICK;
        self.kept += deposit - t2y(ticks);
        let calc = buy_calc(c.r_yes, c.r_no, side, ticks, self.fee_bps).unwrap_or_else(|e| env::panic_str(e));
        require!(calc.shares >= min_shares.0 / TICK, "slippage: fewer shares than min_shares");
        require!(c.collateral + calc.net <= MAX_COLLATERAL_TICKS, "market is at its collateral cap");

        if let Some(eid) = evidence_id {
            let mut ev = self.evidence.get(eid as u32).cloned().unwrap_or_else(|| env::panic_str("no such evidence"));
            require!(ev.claim_id == claim_id, "evidence belongs to a different claim");
            let want = if side == Side::Yes { Stance::Support } else { Stance::Refute };
            require!(ev.stance == want, "cited evidence has the opposite stance to this trade");
            ev.backing = U128(ev.backing.0 + t2y(ticks));
            if ev.author != who {
                ev.independent = U128(ev.independent.0 + t2y(ticks));
            }
            self.evidence.replace(eid as u32, ev);
        }

        c.r_yes = calc.r_yes;
        c.r_no = calc.r_no;
        c.collateral += calc.net;
        c.fee_pool_y += t2y(calc.fee);
        self.liabilities += t2y(calc.net) + t2y(calc.fee);
        c.volume += ticks;
        c.trades += 1;
        let mut p = pos.take().unwrap_or_default();
        if side == Side::Yes {
            c.user_yes += calc.shares;
            p.yes += calc.shares;
        } else {
            c.user_no += calc.shares;
            p.no += calc.shares;
        }
        self.positions.insert(key, p);
        self.push_tape(&mut c, &who, side, true, t2y(ticks), evidence_id);
        self.check_solvent(&c);
        self.save(c);
        U128(t2y(calc.shares))
    }

    /// Sell shares back to the pool. Pays the caller immediately. Returns NEAR paid after fee (yocto).
    pub fn sell(&mut self, claim_id: u64, side: Side, shares: U128, min_proceeds: U128) -> U128 {
        let who = env::predecessor_account_id();
        let mut c = self.claim(claim_id);
        let key = (claim_id, who.clone());
        let mut p = self.positions.get(&key).copied().unwrap_or_default();
        let s = shares.0 / TICK;
        let held = if side == Side::Yes { p.yes } else { p.no };
        require!(s > 0, "nothing to sell");
        require!(s <= held, "you do not hold that many shares");
        let calc = sell_calc(c.r_yes, c.r_no, side, s, self.fee_bps).unwrap_or_else(|e| env::panic_str(e));
        let net = calc.gross - calc.fee;
        require!(t2y(net) >= min_proceeds.0, "slippage: proceeds below min_proceeds");

        c.r_yes = calc.r_yes;
        c.r_no = calc.r_no;
        c.collateral -= calc.gross;
        c.fee_pool_y += t2y(calc.fee);
        self.liabilities -= t2y(net);
        c.volume += calc.gross;
        c.trades += 1;
        if side == Side::Yes {
            c.user_yes -= s;
            p.yes -= s;
        } else {
            c.user_no -= s;
            p.no -= s;
        }
        self.positions.insert(key, p);
        self.push_tape(&mut c, &who, side, false, t2y(calc.gross), None);
        self.check_solvent(&c);
        self.save(c);
        self.pay(&who, t2y(net));
        U128(t2y(net))
    }

    /// After the bond window, anyone can settle an evidence bond. If trades citing the evidence total at least the
    /// bond, it returns to the author; otherwise it goes to the claim's fee pool.
    pub fn settle_bond(&mut self, evidence_id: u64) -> BondState {
        let mut ev = self.evidence.get(evidence_id as u32).cloned().unwrap_or_else(|| env::panic_str("no such evidence"));
        require!(ev.bond_state == BondState::Open, "bond already settled");
        require!(env::block_timestamp_ms() >= ev.posted_ms + self.bond_window_ms, "bond window still open");
        if ev.backing.0 >= ev.bond.0 {
            ev.bond_state = BondState::Refunded;
            let (author, bond) = (ev.author.clone(), ev.bond.0);
            self.evidence.replace(evidence_id as u32, ev);
            self.liabilities -= bond;
            self.pay(&author, bond);
            BondState::Refunded
        } else {
            ev.bond_state = BondState::Forfeited;
            let mut c = self.claim(ev.claim_id);
            c.fee_pool_y += ev.bond.0;
            self.evidence.replace(evidence_id as u32, ev);
            self.save(c);
            BondState::Forfeited
        }
    }

    /// The claim's creator collects trading fees and forfeited bonds.
    pub fn withdraw_fees(&mut self, claim_id: u64) -> U128 {
        let mut c = self.claim(claim_id);
        require!(env::predecessor_account_id() == c.creator, "only the claim's creator can withdraw fees");
        let amount = c.fee_pool_y;
        require!(amount > 0, "no fees to withdraw");
        c.fee_pool_y = 0;
        let creator = c.creator.clone();
        self.save(c);
        self.liabilities -= amount;
        self.pay(&creator, amount);
        U128(amount)
    }

    /// Called after every payout. If the transfer failed (the recipient account no longer exists, say) the NEAR is still
    /// here, so it stops counting as paid out and is booked as kept and stranded, which keeps the accounting identity true
    /// and makes the amount visible in `get_accounting`.
    #[private]
    pub fn on_paid(&mut self, amount: U128) {
        let delivered = env::promise_results_count() == 1 && matches!(env::promise_result(0), PromiseResult::Successful(_));
        if !delivered {
            self.total_out -= amount.0;
            self.kept += amount.0;
            self.stranded += amount.0;
            log!("EVENT_JSON:{}", json!({"standard":"verity","version":"1.0.0","event":"stranded","data":{"amount":amount}}));
        }
    }

    // ── views ──────────────────────────────────────────────

    pub fn get_config(&self) -> Config {
        Config {
            fee_bps: self.fee_bps,
            bond_window_ms: self.bond_window_ms,
            claims: u64::from(self.claims.len()),
            evidence: u64::from(self.evidence.len()),
            links: u64::from(self.links.len()),
        }
    }

    pub fn get_claim(&self, claim_id: u64) -> Option<ClaimView> {
        self.claims.get(claim_id as u32).map(Self::view)
    }

    pub fn get_claims(&self, from_index: u64, limit: u64) -> Vec<ClaimView> {
        let n = u64::from(self.claims.len());
        (from_index..n.min(from_index.saturating_add(limit.min(50))))
            .filter_map(|i| self.claims.get(i as u32))
            .map(Self::view)
            .collect()
    }

    /// Topics in the order they were first used, `limit` (at most 200, default 100) from `from_index`. Anyone can open a topic, so the
    /// list has no bound; at 0.077 Tgas a topic, returning all of it would pass the 200 Tgas a view call may use at about 2,500.
    pub fn get_topics(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<String> {
        let n = u64::from(self.topic_list.len());
        let from = from_index.unwrap_or(0);
        let to = n.min(from.saturating_add(limit.unwrap_or(100).min(200)));
        (from..to).filter_map(|i| self.topic_list.get(i as u32).cloned()).collect()
    }

    pub fn get_claims_by_topic(&self, topic: String) -> Vec<ClaimView> {
        self.topics
            .get(&topic)
            .map(|ids| ids.iter().filter_map(|i| self.claims.get(*i as u32)).map(Self::view).collect())
            .unwrap_or_default()
    }

    pub fn get_evidence(&self, evidence_id: u64) -> Option<Evidence> {
        self.evidence.get(evidence_id as u32).cloned()
    }

    pub fn get_claim_evidence(&self, claim_id: u64) -> Vec<Evidence> {
        self.claims
            .get(claim_id as u32)
            .map(|c| c.evidence.iter().filter_map(|e| self.evidence.get(*e as u32)).cloned().collect())
            .unwrap_or_default()
    }

    /// Up to 100 pieces of evidence from `from_index`, in id order (the bond keeper walks the whole list this way).
    pub fn get_evidence_page(&self, from_index: u64, limit: Option<u64>) -> Vec<Evidence> {
        let n = u64::from(self.evidence.len());
        let to = n.min(from_index.saturating_add(limit.unwrap_or(100).min(100)));
        (from_index..to).filter_map(|i| self.evidence.get(i as u32).cloned()).collect()
    }

    pub fn get_link(&self, link_id: u64) -> Option<Link> {
        self.links.get(link_id as u32).cloned()
    }

    pub fn get_links(&self, from_index: u64, limit: u64) -> Vec<Link> {
        let n = u64::from(self.links.len());
        (from_index..n.min(from_index.saturating_add(limit.min(100))))
            .filter_map(|i| self.links.get(i as u32))
            .cloned()
            .collect()
    }

    pub fn get_position(&self, claim_id: u64, account: AccountId) -> PositionView {
        let p = self.positions.get(&(claim_id, account)).copied().unwrap_or_default();
        PositionView { yes: U128(t2y(p.yes)), no: U128(t2y(p.no)) }
    }

    /// What a buy would give. Pass `account` to include the 0.002 NEAR a first trade of this claim costs that account.
    pub fn quote_buy(&self, claim_id: u64, side: Side, amount: U128, account: Option<AccountId>) -> QuoteView {
        let c = self.claim(claim_id);
        let mut paid = amount.0;
        if let Some(a) = account {
            if self.positions.get(&(claim_id, a)).is_none() {
                paid = paid.saturating_sub(POSITION_FEE_Y);
            }
        }
        let ticks = paid / TICK;
        let calc = buy_calc(c.r_yes, c.r_no, side, ticks, self.fee_bps).unwrap_or_else(|e| env::panic_str(e));
        QuoteView {
            out: U128(t2y(calc.shares)),
            fee: U128(t2y(calc.fee)),
            price_before_bps: price_bps(c.r_yes, c.r_no),
            price_after_bps: price_bps(calc.r_yes, calc.r_no),
        }
    }

    pub fn quote_sell(&self, claim_id: u64, side: Side, shares: U128) -> QuoteView {
        let c = self.claim(claim_id);
        let calc = sell_calc(c.r_yes, c.r_no, side, shares.0 / TICK, self.fee_bps).unwrap_or_else(|e| env::panic_str(e));
        QuoteView {
            out: U128(t2y(calc.gross - calc.fee)),
            fee: U128(t2y(calc.fee)),
            price_before_bps: price_bps(c.r_yes, c.r_no),
            price_after_bps: price_bps(calc.r_yes, calc.r_no),
        }
    }

    /// Links whose two sides are priced inconsistently, most significant first. `min_link_conf_bps` ignores links
    /// the crowd does not believe; `min_gap_bps` ignores small inconsistencies. Looks at the newest `MAX_VIOLATION_SCAN` links,
    /// or, given `before`, at the ones just before that link index (so a caller can walk back through older windows).
    pub fn get_violations(&self, min_link_conf_bps: u16, min_gap_bps: u16, limit: u64, before: Option<u64>) -> Vec<Violation> {
        // The newest links first: a contradiction someone has just opened is the one that matters, and an old table must not
        // push it past the scan limit.
        let total = before.map_or(u64::from(self.links.len()), |b| b.min(u64::from(self.links.len())));
        let mut out: Vec<Violation> = Vec::new();
        for i in (total.saturating_sub(MAX_VIOLATION_SCAN)..total).rev() {
            let l = self.links.get(i as u32).unwrap();
            let (ca, cb, cl) = match (self.claims.get(l.a as u32), self.claims.get(l.b as u32), self.claims.get(l.claim_id as u32)) {
                (Some(a), Some(b), Some(c)) => (a, b, c),
                _ => continue,
            };
            let pa = i32::from(price_bps(ca.r_yes, ca.r_no));
            let pb = i32::from(price_bps(cb.r_yes, cb.r_no));
            let conf = price_bps(cl.r_yes, cl.r_no);
            let gap = match l.rel {
                Rel::Implies => pa - pb,
                Rel::Excludes => pa + pb - BPS as i32,
            };
            if gap <= 0 || gap < i32::from(min_gap_bps) || conf < min_link_conf_bps {
                continue;
            }
            out.push(Violation {
                link_id: l.id,
                link_claim: l.claim_id,
                rel: l.rel,
                a: l.a,
                b: l.b,
                price_a_bps: pa as u16,
                price_b_bps: pb as u16,
                link_conf_bps: conf,
                gap_bps: gap as u16,
                score: (gap as u32) * u32::from(conf) / BPS as u32,
            });
        }
        out.sort_by(|x, y| y.score.cmp(&x.score));
        out.truncate(limit.min(50) as usize);
        out
    }

    /// Anyone can audit solvency: `total_in - total_out == liabilities + kept`, and the contract's NEAR balance
    /// should be at least `liabilities`.
    pub fn get_accounting(&self) -> Accounting {
        Accounting { total_in: U128(self.total_in), total_out: U128(self.total_out), liabilities: U128(self.liabilities), kept: U128(self.kept), stranded: U128(self.stranded) }
    }
}

// ── internals ──────────────────────────────────────────────────────────────────────────────────────────

impl Verity {
    fn claim(&self, id: u64) -> Claim {
        self.claims.get(id as u32).cloned().unwrap_or_else(|| env::panic_str("no such claim"))
    }

    fn save(&mut self, c: Claim) {
        let id = c.id as u32;
        self.claims.replace(id, c);
    }

    fn pay(&mut self, to: &AccountId, amount_y: u128) {
        if amount_y == 0 {
            return;
        }
        self.total_out += amount_y;
        let _ = Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount_y))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(5)).on_paid(U128(amount_y)));
    }

    fn check_solvent(&self, c: &Claim) {
        require!(
            c.collateral == c.r_yes + c.user_yes && c.collateral == c.r_no + c.user_no,
            "invariant violated: pool is not fully collateralised"
        );
    }

    fn push_tape(&self, c: &mut Claim, who: &AccountId, side: Side, buy: bool, amount_y: u128, evidence: Option<u64>) {
        if c.tape.len() >= TAPE_CAP {
            c.tape.remove(0);
        }
        c.tape.push(TradeRec {
            ts_ms: env::block_timestamp_ms(),
            who: who.clone(),
            side,
            buy,
            amount: U128(amount_y),
            price_bps: price_bps(c.r_yes, c.r_no),
            evidence,
        });
    }

    fn open_market(&mut self, topic: String, text: String, prior_bps: u16, deposit: u128, link_id: Option<u64>) -> u64 {
        require!((MIN_PRIOR_BPS..=MAX_PRIOR_BPS).contains(&prior_bps), "prior must be between 500 and 9500 bps");
        require!(deposit >= CLAIM_FEE_Y, "deposit does not cover the claim fee");
        let seed_y = deposit - CLAIM_FEE_Y;
        let seed = seed_y / TICK;
        require!(t2y(seed) >= MIN_SEED_Y, "seed must be at least 0.5 NEAR after the 0.07 NEAR claim fee");
        require!(seed <= MAX_COLLATERAL_TICKS, "seed above the per-market cap");
        self.kept += CLAIM_FEE_Y + (seed_y - t2y(seed));
        self.liabilities += t2y(seed);

        let p = u128::from(prior_bps);
        let (r_yes, r_no, user_yes, user_no) = if p <= BPS / 2 {
            let rn = seed * p / (BPS - p);
            (seed, rn, 0, seed - rn)
        } else {
            let ry = seed * (BPS - p) / p;
            (ry, seed, seed - ry, 0)
        };

        let id = u64::from(self.claims.len());
        let creator = env::predecessor_account_id();
        // Link markets all share the reserved topic and are reached through `get_links`, not by topic: listing them would
        // cap the whole contract at 60 links and make that view grow without bound.
        if link_id.is_none() {
            if self.topics.get(&topic).is_none() {
                self.topic_list.push(topic.clone());
                self.topics.insert(topic.clone(), Vec::new());
            }
            let ids = self.topics.get_mut(&topic).unwrap();
            require!(ids.len() < MAX_CLAIMS_PER_TOPIC, "topic is full");
            ids.push(id);
        }

        let c = Claim {
            id,
            topic: topic.clone(),
            text,
            creator: creator.clone(),
            created_ms: env::block_timestamp_ms(),
            r_yes,
            r_no,
            collateral: seed,
            user_yes,
            user_no,
            volume: 0,
            trades: 0,
            fee_pool_y: 0,
            evidence: Vec::new(),
            links: Vec::new(),
            link_id,
            tape: Vec::new(),
        };
        self.check_solvent(&c);
        if user_yes + user_no > 0 {
            self.positions.insert((id, creator.clone()), Position { yes: user_yes, no: user_no });
        }
        self.claims.push(c);
        log!("EVENT_JSON:{}", json!({"standard":"verity","version":"1.0.0","event":"claim","data":{"id":id,"topic":topic,"creator":creator,"prior_bps":prior_bps}}));
        id
    }

    fn view(c: &Claim) -> ClaimView {
        ClaimView {
            id: c.id,
            topic: c.topic.clone(),
            text: c.text.clone(),
            creator: c.creator.clone(),
            created_ms: c.created_ms,
            price_bps: price_bps(c.r_yes, c.r_no),
            collateral: U128(t2y(c.collateral)),
            reserve_yes: U128(t2y(c.r_yes)),
            reserve_no: U128(t2y(c.r_no)),
            volume: U128(t2y(c.volume)),
            trades: c.trades,
            fee_pool: U128(c.fee_pool_y),
            evidence: c.evidence.clone(),
            links: c.links.clone(),
            link_id: c.link_id,
            tape: c.tape.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const N: u128 = 1_000_000_000_000_000_000_000_000;
    const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(who: &str, deposit: u128, ts_s: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts_s * 1_000_000_000)
            .build());
    }

    fn fresh() -> Verity {
        ctx("deployer.near", 0, 1);
        Verity::new(60, 100)
    }

    fn seed_claim(v: &mut Verity, prior: u16) -> u64 {
        ctx("alice.near", CLAIM_FEE_Y + 10 * N, 2);
        v.create_claim("pluto".into(), "Pluto is a dwarf planet.".into(), prior)
    }

    fn audit(v: &Verity) {
        let a = v.get_accounting();
        assert_eq!(a.total_in.0 - a.total_out.0, a.liabilities.0 + a.kept.0, "accounting identity broke");
        let mut owed: u128 = 0;
        for c in v.claims.iter() {
            owed += t2y(c.collateral) + c.fee_pool_y;
        }
        for e in v.evidence.iter() {
            if e.bond_state == BondState::Open {
                owed += e.bond.0;
            }
        }
        assert_eq!(owed, a.liabilities.0, "running liabilities counter drifted from the real sum");
        for c in v.claims.iter() {
            assert_eq!(c.collateral, c.r_yes + c.user_yes);
            assert_eq!(c.collateral, c.r_no + c.user_no);
        }
    }

    #[test]
    fn isqrt_is_a_ceiling_root() {
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, 1 << 60, (1 << 90) + 7, u128::MAX / 4] {
            let r = isqrt_ceil(n);
            assert!(r * r >= n, "{n}");
            if r > 0 {
                assert!((r - 1) * (r - 1) < n, "{n}");
            }
        }
    }

    #[test]
    fn opens_at_the_requested_prior() {
        for prior in [500u16, 2_000, 5_000, 7_300, 9_500] {
            let mut v = fresh();
            let id = seed_claim(&mut v, prior);
            let c = v.get_claim(id).unwrap();
            assert!((i32::from(c.price_bps) - i32::from(prior)).abs() <= 1, "{prior} -> {}", c.price_bps);
            audit(&v);
        }
    }

    #[test]
    fn buying_yes_raises_price_and_buying_no_lowers_it() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        ctx("bob.near", N, 3);
        let before = v.get_claim(id).unwrap().price_bps;
        let shares = v.buy(id, Side::Yes, U128(0), None).0;
        let mid = v.get_claim(id).unwrap().price_bps;
        assert!(mid > before);
        assert!(shares > N * 99 / 100, "shares should exceed the net paid when price < 1");
        ctx("carol.near", 3 * N, 4);
        v.buy(id, Side::No, U128(0), None);
        assert!(v.get_claim(id).unwrap().price_bps < mid);
        audit(&v);
    }

    #[test]
    fn round_trip_never_profits() {
        for side in [Side::Yes, Side::No] {
            let mut v = fresh();
            let id = seed_claim(&mut v, 3_000);
            ctx("bob.near", 2 * N, 3);
            let shares = v.buy(id, side, U128(0), None);
            ctx("bob.near", 0, 4);
            let back = v.sell(id, side, shares, U128(0)).0;
            assert!(back < 2 * N - POSITION_FEE_Y, "round trip returned {back}");
            assert!(back > 2 * N * 97 / 100, "round trip lost too much: {back}");
            audit(&v);
        }
    }

    #[test]
    fn quotes_match_execution() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 6_000);
        ctx("bob.near", N, 3);
        let q = v.quote_buy(id, Side::No, U128(N - POSITION_FEE_Y), None);
        let got = v.buy(id, Side::No, U128(0), None);
        assert_eq!(q.out.0, got.0);
        assert_eq!(q.price_after_bps, v.get_claim(id).unwrap().price_bps);
    }

    #[test]
    fn random_walk_keeps_every_invariant() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 4_000);
        let who = ["bob.near", "carol.near", "dave.near"];
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for step in 0..1_500u64 {
            let r = next();
            let w = who[(r % 3) as usize];
            let side = if (r >> 8) & 1 == 0 { Side::Yes } else { Side::No };
            let pos = v.get_position(id, acct(w));
            let held = if side == Side::Yes { pos.yes.0 } else { pos.no.0 };
            if (r >> 16) % 3 == 0 && held >= TICK * 10 {
                let part = held / (1 + u128::from((r >> 24) % 4));
                ctx(w, 0, 10 + step);
                v.sell(id, side, U128(part), U128(0));
            } else {
                let amt = N / 50 + u128::from((r >> 32) % 400) * N / 1000;
                ctx(w, amt, 10 + step);
                v.buy(id, side, U128(0), None);
            }
            let p = v.get_claim(id).unwrap().price_bps;
            assert!((1..=9_999).contains(&p));
            audit(&v);
        }
    }

    #[test]
    fn product_never_decreases() {
        let mut ry = 10_000_000_000u128;
        let mut rn = 10_000_000_000u128;
        let mut seed: u64 = 12345;
        for _ in 0..3_000 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let side = if seed >> 63 == 0 { Side::Yes } else { Side::No };
            let k = ry * rn;
            let amt = 1 + u128::from((seed >> 20) % 2_000_000_000);
            let b = buy_calc(ry, rn, side, amt, 100).unwrap();
            assert!(b.r_yes * b.r_no >= k);
            ry = b.r_yes;
            rn = b.r_no;
            let held = b.shares / 2;
            if held > 0 {
                let k2 = ry * rn;
                let s = sell_calc(ry, rn, side, held, 100).unwrap();
                assert!(s.r_yes * s.r_no >= k2);
                ry = s.r_yes;
                rn = s.r_no;
            }
        }
    }

    #[test]
    #[should_panic(expected = "you do not hold that many shares")]
    fn cannot_sell_what_you_do_not_hold() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        ctx("bob.near", N, 3);
        v.buy(id, Side::Yes, U128(0), None);
        ctx("bob.near", 0, 4);
        v.sell(id, Side::No, U128(TICK * 100), U128(0));
    }

    #[test]
    #[should_panic(expected = "slippage: fewer shares")]
    fn buy_respects_min_shares() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        ctx("bob.near", N, 3);
        v.buy(id, Side::Yes, U128(3 * N), None);
    }

    #[test]
    #[should_panic(expected = "slippage: proceeds")]
    fn sell_respects_min_proceeds() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        ctx("bob.near", N, 3);
        let s = v.buy(id, Side::Yes, U128(0), None);
        ctx("bob.near", 0, 4);
        v.sell(id, Side::Yes, s, U128(N));
    }

    fn post_ev(v: &mut Verity, id: u64, who: &str, stance: Stance, ts: u64) -> u64 {
        ctx(who, EVIDENCE_FEE_Y + MIN_BOND_Y, ts);
        v.post_evidence(id, stance, "https://en.wikipedia.org/wiki/Pluto".into(), HASH.into(), "IAU 2006 definition".into())
    }

    #[test]
    fn bond_is_refunded_when_other_capital_follows() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        let ev = post_ev(&mut v, id, "res.near", Stance::Support, 3);
        ctx("bob.near", 3 * N, 4);
        v.buy(id, Side::Yes, U128(0), Some(ev));
        assert!(v.get_evidence(ev).unwrap().backing.0 >= MIN_BOND_Y);
        ctx("anyone.near", 0, 3 + 61);
        assert_eq!(v.settle_bond(ev), BondState::Refunded);
        audit(&v);
    }

    #[test]
    fn authors_own_backing_saves_the_bond_but_is_not_independent() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        let ev = post_ev(&mut v, id, "res.near", Stance::Refute, 3);
        ctx("res.near", 3 * N, 4);
        v.buy(id, Side::No, U128(0), Some(ev));
        let e = v.get_evidence(ev).unwrap();
        assert!(e.backing.0 >= MIN_BOND_Y);
        assert_eq!(e.independent.0, 0);
        ctx("bob.near", N, 5);
        v.buy(id, Side::No, U128(0), Some(ev));
        assert!(v.get_evidence(ev).unwrap().independent.0 > 0);
        ctx("anyone.near", 0, 3 + 61);
        assert_eq!(v.settle_bond(ev), BondState::Refunded);
        audit(&v);
    }

    #[test]
    fn bond_is_forfeited_when_no_capital_cites_the_evidence() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        let ev = post_ev(&mut v, id, "res.near", Stance::Refute, 3);
        ctx("bob.near", 3 * N, 4);
        v.buy(id, Side::No, U128(0), None);
        ctx("anyone.near", 0, 3 + 61);
        assert_eq!(v.settle_bond(ev), BondState::Forfeited);
        assert!(v.get_claim(id).unwrap().fee_pool.0 >= MIN_BOND_Y);
        audit(&v);
    }

    #[test]
    #[should_panic(expected = "bond window still open")]
    fn bond_cannot_be_settled_early() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        let ev = post_ev(&mut v, id, "res.near", Stance::Support, 3);
        ctx("anyone.near", 0, 10);
        v.settle_bond(ev);
    }

    #[test]
    #[should_panic(expected = "opposite stance")]
    fn citing_evidence_requires_matching_side() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        let ev = post_ev(&mut v, id, "res.near", Stance::Support, 3);
        ctx("bob.near", N, 4);
        v.buy(id, Side::No, U128(0), Some(ev));
    }

    #[test]
    #[should_panic(expected = "different claim")]
    fn citing_evidence_from_another_claim_fails() {
        let mut v = fresh();
        let a = seed_claim(&mut v, 5_000);
        ctx("alice.near", CLAIM_FEE_Y + 2 * N, 2);
        let b = v.create_claim("pluto".into(), "Pluto has five known moons.".into(), 5_000);
        let ev = post_ev(&mut v, a, "res.near", Stance::Support, 3);
        ctx("bob.near", N, 4);
        v.buy(b, Side::Yes, U128(0), Some(ev));
    }

    #[test]
    fn creator_collects_fees() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        ctx("bob.near", 5 * N, 3);
        v.buy(id, Side::Yes, U128(0), None);
        ctx("alice.near", 0, 4);
        let got = v.withdraw_fees(id).0;
        assert!(got > 0 && got <= N / 20);
        audit(&v);
    }

    #[test]
    #[should_panic(expected = "only the claim's creator")]
    fn others_cannot_collect_fees() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        ctx("bob.near", 5 * N, 3);
        v.buy(id, Side::Yes, U128(0), None);
        ctx("bob.near", 0, 4);
        v.withdraw_fees(id);
    }

    fn two_claims(v: &mut Verity) -> (u64, u64) {
        ctx("alice.near", CLAIM_FEE_Y + 3 * N, 2);
        let a = v.create_claim("pluto".into(), "Pluto is the ninth planet.".into(), 5_000);
        ctx("alice.near", CLAIM_FEE_Y + 3 * N, 2);
        let b = v.create_claim("pluto".into(), "Pluto orbits the Sun.".into(), 5_000);
        (a, b)
    }

    #[test]
    fn implies_link_reports_violation_weighted_by_belief() {
        let mut v = fresh();
        let (a, b) = two_claims(&mut v);
        ctx("alice.near", CLAIM_FEE_Y + 3 * N, 3);
        let lc = v.create_link(a, b, Rel::Implies, 9_000);
        assert!(v.get_violations(0, 0, 10, None).is_empty(), "equal prices are consistent");
        ctx("bob.near", 4 * N, 4);
        v.buy(a, Side::Yes, U128(0), None);
        let viol = v.get_violations(5_000, 100, 10, None);
        assert_eq!(viol.len(), 1);
        assert_eq!(viol[0].link_claim, lc);
        assert!(viol[0].gap_bps > 1_000);
        assert!(viol[0].link_conf_bps >= 8_900);
        ctx("carol.near", 20 * N, 5);
        v.buy(lc, Side::No, U128(0), None);
        assert!(v.get_violations(5_000, 100, 10, None).is_empty(), "a disbelieved link stops being reported");
        assert_eq!(v.get_violations(0, 100, 10, None).len(), 1);
        audit(&v);
    }

    #[test]
    fn excludes_link_reports_when_both_are_high() {
        let mut v = fresh();
        let (a, b) = two_claims(&mut v);
        ctx("alice.near", CLAIM_FEE_Y + 3 * N, 3);
        v.create_link(a, b, Rel::Excludes, 9_000);
        ctx("bob.near", 6 * N, 4);
        v.buy(a, Side::Yes, U128(0), None);
        ctx("bob.near", 6 * N, 5);
        v.buy(b, Side::Yes, U128(0), None);
        let viol = v.get_violations(0, 0, 10, None);
        assert_eq!(viol.len(), 1);
        assert!(viol[0].price_a_bps + viol[0].price_b_bps > 10_000);
    }

    #[test]
    #[should_panic(expected = "link already exists")]
    fn duplicate_links_are_rejected() {
        let mut v = fresh();
        let (a, b) = two_claims(&mut v);
        for _ in 0..2 {
            ctx("alice.near", CLAIM_FEE_Y + 3 * N, 3);
            v.create_link(a, b, Rel::Implies, 9_000);
        }
    }

    #[test]
    #[should_panic(expected = "not other links")]
    fn links_cannot_link_links() {
        let mut v = fresh();
        let (a, b) = two_claims(&mut v);
        ctx("alice.near", CLAIM_FEE_Y + 3 * N, 3);
        let lc = v.create_link(a, b, Rel::Implies, 9_000);
        ctx("alice.near", CLAIM_FEE_Y + 3 * N, 3);
        v.create_link(lc, a, Rel::Implies, 9_000);
    }

    #[test]
    #[should_panic(expected = "reserved topic")]
    fn link_topic_is_reserved() {
        let mut v = fresh();
        ctx("alice.near", CLAIM_FEE_Y + 3 * N, 2);
        v.create_claim("meta:links".into(), "A perfectly ordinary claim.".into(), 5_000);
    }

    #[test]
    fn input_validation() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        let bad_topics = ["", "Has Caps", "has space", &"x".repeat(65)];
        for t in bad_topics {
            ctx("alice.near", CLAIM_FEE_Y + 3 * N, 2);
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                v.create_claim(t.into(), "A perfectly ordinary claim.".into(), 5_000)
            }));
            assert!(r.is_err(), "topic {t:?} should be rejected");
        }
        for (uri, hash) in [("ftp://x.org/a", HASH), ("https://x.org/a b", HASH), ("https://x.org/a", "ABC"), ("https://x.org/a", &HASH.to_uppercase())] {
            ctx("res.near", EVIDENCE_FEE_Y + MIN_BOND_Y, 3);
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                v.post_evidence(id, Stance::Support, uri.into(), hash.into(), String::new())
            }));
            assert!(r.is_err(), "{uri} / {hash} should be rejected");
        }
    }

    #[test]
    fn text_limits_are_in_bytes_so_storage_fees_cover_worst_case() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        // 100 four-byte characters: 100 chars but 400 bytes.
        let wide = "\u{1F600}".repeat(100);
        ctx("alice.near", CLAIM_FEE_Y + 3 * N, 2);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| v.create_claim("pluto".into(), wide.clone(), 5_000)));
        assert!(r.is_err(), "400 bytes must be rejected");
        ctx("res.near", EVIDENCE_FEE_Y + MIN_BOND_Y, 3);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            v.post_evidence(id, Stance::Support, "https://x.org/a".into(), HASH.into(), wide.clone())
        }));
        assert!(r.is_err(), "400-byte note must be rejected");
        ctx("alice.near", CLAIM_FEE_Y + 3 * N, 2);
        v.create_claim("pluto".into(), "\u{1F600}".repeat(70), 5_000);
    }

    #[test]
    #[should_panic(expected = "topic is full")]
    fn topics_are_capped() {
        let mut v = fresh();
        for i in 0..=MAX_CLAIMS_PER_TOPIC {
            ctx("alice.near", CLAIM_FEE_Y + N, 2);
            v.create_claim("crowded".into(), format!("Claim number {i} in a crowded topic."), 5_000);
        }
    }

    #[test]
    fn tape_is_capped() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        for i in 0..(TAPE_CAP as u64 + 10) {
            ctx("bob.near", N / 10, 3 + i);
            v.buy(id, if i % 2 == 0 { Side::Yes } else { Side::No }, U128(0), None);
        }
        let c = v.get_claim(id).unwrap();
        assert_eq!(c.tape.len(), TAPE_CAP);
        assert_eq!(c.trades, TAPE_CAP as u64 + 10);
    }

    #[test]
    fn topics_are_listed() {
        let mut v = fresh();
        seed_claim(&mut v, 5_000);
        ctx("alice.near", CLAIM_FEE_Y + 3 * N, 2);
        v.create_claim("mars".into(), "Mars has two moons.".into(), 5_000);
        assert_eq!(v.get_topics(None, None), vec!["pluto".to_string(), "mars".to_string()]);
        assert_eq!(v.get_topics(Some(1), None), vec!["mars".to_string()]);
        assert_eq!(v.get_topics(Some(0), Some(1)), vec!["pluto".to_string()]);
        assert!(v.get_topics(Some(5), None).is_empty());
        assert_eq!(v.get_claims_by_topic("pluto".into()).len(), 1);
    }

    // ── limits that used to be wrong or missing ───────────────────────────────────────────────────────

    #[test]
    fn link_markets_are_not_capped_by_the_per_topic_limit() {
        let mut v = fresh();
        let mut ids = vec![];
        for i in 0..12 {
            ctx("alice.near", CLAIM_FEE_Y + N, 2);
            ids.push(v.create_claim("t".into(), format!("Claim number {i} for links."), 5_000));
        }
        let mut n = 0;
        'outer: for i in 0..12 {
            for j in (i + 1)..12 {
                ctx("bob.near", CLAIM_FEE_Y + N, 3);
                v.create_link(ids[i], ids[j], Rel::Implies, 9_000);
                n += 1;
                if n == MAX_CLAIMS_PER_TOPIC + 6 {
                    break 'outer;
                }
            }
        }
        assert_eq!(v.get_config().links as usize, MAX_CLAIMS_PER_TOPIC + 6, "more link markets than a topic may hold claims");
        assert!(!v.get_topics(None, None).contains(&LINK_TOPIC.to_string()), "link markets are reached through get_links, not by topic");
        assert!(v.get_claims_by_topic(LINK_TOPIC.into()).is_empty());
        assert_eq!(v.get_links(0, 100).len(), MAX_CLAIMS_PER_TOPIC + 6);
        audit(&v);
    }

    #[test]
    #[should_panic(expected = "link already exists")]
    fn excludes_is_symmetric_so_the_reverse_is_a_duplicate() {
        let mut v = fresh();
        ctx("alice.near", CLAIM_FEE_Y + N, 2);
        let a = v.create_claim("t".into(), "The first claim in a pair.".into(), 5_000);
        ctx("alice.near", CLAIM_FEE_Y + N, 2);
        let b = v.create_claim("t".into(), "The second claim in a pair.".into(), 5_000);
        ctx("bob.near", CLAIM_FEE_Y + N, 3);
        v.create_link(a, b, Rel::Excludes, 9_000);
        ctx("bob.near", CLAIM_FEE_Y + N, 3);
        v.create_link(b, a, Rel::Excludes, 9_000);
    }

    #[test]
    fn implies_is_directional_so_the_reverse_is_a_different_claim() {
        let mut v = fresh();
        ctx("alice.near", CLAIM_FEE_Y + N, 2);
        let a = v.create_claim("t".into(), "The first claim in a pair.".into(), 5_000);
        ctx("alice.near", CLAIM_FEE_Y + N, 2);
        let b = v.create_claim("t".into(), "The second claim in a pair.".into(), 5_000);
        ctx("bob.near", CLAIM_FEE_Y + N, 3);
        v.create_link(a, b, Rel::Implies, 9_000);
        ctx("bob.near", CLAIM_FEE_Y + N, 3);
        v.create_link(b, a, Rel::Implies, 9_000);
        assert_eq!(v.get_config().links, 2);
    }

    fn post(v: &mut Verity, who: &str, claim: u64, n: usize, ts: u64) -> u64 {
        let count = v.get_claim(claim).unwrap().evidence.len() as u128;
        ctx(who, EVIDENCE_FEE_Y + EVIDENCE_FEE_Y * count / EVIDENCE_SURCHARGE_STEPS + MIN_BOND_Y, ts);
        v.post_evidence(claim, Stance::Support, format!("https://x.org/{n}"), HASH.into(), String::new())
    }

    #[test]
    fn evidence_gets_dearer_as_a_claim_fills_and_the_surcharge_goes_to_the_fee_pool() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        for i in 0..9 {
            post(&mut v, &format!("a{i}.near"), id, i, 3);
        }
        assert_eq!(v.get_evidence(0).unwrap().bond.0, MIN_BOND_Y);
        assert_eq!(v.get_evidence(8).unwrap().bond.0, MIN_BOND_Y, "the surcharge is not part of the bond");
        let expect: u128 = (0..9u128).map(|k| EVIDENCE_FEE_Y * k / EVIDENCE_SURCHARGE_STEPS).sum();
        assert_eq!(v.get_claim(id).unwrap().fee_pool.0, expect);
        ctx("z.near", EVIDENCE_FEE_Y + MIN_BOND_Y, 3);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            v.post_evidence(id, Stance::Support, "https://x.org/late".into(), HASH.into(), String::new())
        }));
        assert!(r.is_err(), "the tenth piece costs more than the first");
        audit(&v);
    }

    #[test]
    #[should_panic(expected = "maximum evidence on this claim")]
    fn one_account_cannot_take_more_than_eight_slots() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        for i in 0..=MAX_EVIDENCE_PER_AUTHOR {
            post(&mut v, "same.near", id, i, 3);
        }
    }

    #[test]
    fn a_full_claim_makes_room_by_dropping_forfeited_evidence_and_refuses_otherwise() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        for i in 0..MAX_EVIDENCE_PER_CLAIM {
            post(&mut v, &format!("a{}.near", i / MAX_EVIDENCE_PER_AUTHOR), id, i, 3);
        }
        assert_eq!(v.get_claim(id).unwrap().evidence.len(), MAX_EVIDENCE_PER_CLAIM);
        ctx("z.near", EVIDENCE_FEE_Y * 20, 4);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            v.post_evidence(id, Stance::Support, "https://x.org/new".into(), HASH.into(), String::new())
        }));
        assert!(r.is_err(), "nothing has been forfeited yet, so there is no room");
        ctx("anyone.near", 0, 100);
        assert_eq!(v.settle_bond(0), BondState::Forfeited);
        let fresh_id = post(&mut v, "z.near", id, 999, 100);
        let c = v.get_claim(id).unwrap();
        assert_eq!(c.evidence.len(), MAX_EVIDENCE_PER_CLAIM);
        assert!(!c.evidence.contains(&0) && c.evidence.contains(&fresh_id), "the forfeited evidence made way for the new");
        assert!(v.get_evidence(0).is_some(), "the old record is kept, only its place on the claim is reused");
        audit(&v);
    }

    #[test]
    fn a_quote_for_a_new_trader_includes_the_position_fee() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        let plain = v.quote_buy(id, Side::Yes, U128(N), None).out.0;
        let newcomer = v.quote_buy(id, Side::Yes, U128(N), Some(acct("bob.near"))).out.0;
        assert!(newcomer < plain);
        ctx("bob.near", N, 3);
        assert_eq!(v.buy(id, Side::Yes, U128(0), None).0, newcomer, "the quote is what the buy then delivers");
        let with = v.quote_buy(id, Side::Yes, U128(N), Some(acct("bob.near"))).out.0;
        assert_eq!(with, v.quote_buy(id, Side::Yes, U128(N), None).out.0, "bob has a position now, so no fee is deducted");
    }

    #[test]
    fn a_claim_at_every_limit_still_fits_in_what_the_claim_fee_pays_for() {
        let who: AccountId = "a".repeat(64).parse().unwrap();
        let rec = TradeRec { ts_ms: u64::MAX, who: who.clone(), side: Side::Yes, buy: true, amount: U128(u128::MAX), price_bps: u16::MAX, evidence: Some(u64::MAX) };
        let c = Claim {
            id: u64::MAX, topic: "t".repeat(MAX_TOPIC), text: "x".repeat(MAX_TEXT), creator: who, created_ms: u64::MAX,
            r_yes: u128::MAX, r_no: u128::MAX, collateral: u128::MAX, user_yes: u128::MAX, user_no: u128::MAX, volume: u128::MAX,
            trades: u64::MAX, fee_pool_y: u128::MAX, evidence: vec![u64::MAX; MAX_EVIDENCE_PER_CLAIM], links: vec![u64::MAX; MAX_LINKS_PER_CLAIM],
            link_id: Some(u64::MAX), tape: vec![rec; TAPE_CAP],
        };
        let bytes = near_sdk::borsh::to_vec(&c).unwrap().len() as u128;
        let paid_for = CLAIM_FEE_Y / env::storage_byte_cost().as_yoctonear();
        // 150 bytes for the key, the vector slot and the trie's own bookkeeping.
        assert!(bytes + 150 <= paid_for, "a claim at every limit is {bytes} bytes but the claim fee pays for {paid_for}");
    }

    #[test]
    fn a_claim_takes_sixty_four_links_and_refuses_the_next() {
        let mut v = fresh();
        ctx("alice.near", CLAIM_FEE_Y + N, 2);
        let hub = v.create_claim("hub".into(), "The claim every lie contradicts.".into(), 5_000);
        let mut others = vec![];
        for i in 0..=MAX_LINKS_PER_CLAIM {
            ctx("alice.near", CLAIM_FEE_Y + N, 2);
            others.push(v.create_claim(format!("lies{}", i / 50), format!("Lie number {i} about the hub."), 8_000));
        }
        for o in &others[..MAX_LINKS_PER_CLAIM] {
            ctx("bob.near", CLAIM_FEE_Y + N, 3);
            v.create_link(hub, *o, Rel::Excludes, 9_000);
        }
        assert_eq!(v.get_claim(hub).unwrap().links.len(), MAX_LINKS_PER_CLAIM);
        ctx("bob.near", CLAIM_FEE_Y + N, 3);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| v.create_link(hub, others[MAX_LINKS_PER_CLAIM], Rel::Excludes, 9_000)));
        assert!(r.is_err(), "the sixty-fifth link is refused");
        audit(&v);
    }

    /// Two fresh claims and a link between them; returns the link's id.
    fn pair(v: &mut Verity, n: usize, prior: u16) -> u64 {
        ctx("alice.near", CLAIM_FEE_Y + N, 2);
        let a = v.create_claim(format!("pa{n}"), format!("Pair {n}, the first claim."), prior);
        ctx("alice.near", CLAIM_FEE_Y + N, 2);
        let b = v.create_claim(format!("pb{n}"), format!("Pair {n}, the second claim."), prior);
        ctx("bob.near", CLAIM_FEE_Y + N, 3);
        v.create_link(a, b, Rel::Excludes, 9_000);
        u64::from(v.links.len()) - 1
    }

    #[test]
    fn the_scan_reads_the_newest_links_and_older_ones_are_reached_by_passing_before() {
        let mut v = fresh();
        let oldest = pair(&mut v, 0, 8_000); // contradictory, but older than one window reaches
        for n in 1..=(MAX_VIOLATION_SCAN as usize + 20) {
            pair(&mut v, n, 2_000); // consistent: 20% + 20% < 100%
        }
        let newest = pair(&mut v, 9_999, 8_000);
        let total = u64::from(v.links.len());
        assert!(total > MAX_VIOLATION_SCAN + 20);
        let found: Vec<u64> = v.get_violations(0, 1, 50, None).iter().map(|x| x.link_id).collect();
        assert_eq!(found, vec![newest], "only the newest window is read; the oldest contradiction was link {oldest}");
        // Walking back one window at a time reaches it.
        let mut seen = vec![];
        let mut hi = total;
        while hi > 0 {
            seen.extend(v.get_violations(0, 1, 50, Some(hi)).iter().map(|x| x.link_id));
            hi = hi.saturating_sub(MAX_VIOLATION_SCAN);
        }
        seen.sort();
        assert_eq!(seen, vec![oldest, newest]);
        assert!(v.get_violations(0, 1, 50, Some(0)).is_empty(), "before the first link there is nothing");
        assert_eq!(v.get_violations(0, 1, 50, Some(total + 1_000)).iter().map(|x| x.link_id).collect::<Vec<_>>(), vec![newest], "a `before` past the end is the newest window");
    }

    #[test]
    fn a_mixed_random_walk_of_every_operation_keeps_the_books_balanced() {
        let mut v = fresh();
        let who: Vec<String> = (0..12).map(|i| format!("w{i}.near")).collect();
        let mut claims: Vec<u64> = vec![];
        for i in 0..4usize {
            ctx("alice.near", CLAIM_FEE_Y + 4 * N, 2);
            claims.push(v.create_claim(format!("walk{i}"), format!("Walk claim number {i}."), 3_000 + 1_500 * i as u16));
        }
        let mut seed: u64 = 0xD1B5_4A32_D192_ED03;
        let mut next = move || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed };
        let mut linked: std::collections::HashSet<(u64, u64)> = Default::default();
        let mut t: u64 = 3;
        let (mut posted, mut settled, mut evicted_at_full, mut withdrawn, mut links_made) = (0, 0, 0, 0, 0);
        for _ in 0..4_000u64 {
            t += 3;
            let r = next();
            let w = who[(r % 12) as usize].as_str();
            let cid = claims[((r >> 8) % 4) as usize];
            let c = v.get_claim(cid).unwrap();
            match (r >> 16) % 10 {
                0..=2 => {
                    // buy, citing a matching piece of evidence now and then
                    let side = if (r >> 24) & 1 == 0 { Side::Yes } else { Side::No };
                    let want = if side == Side::Yes { Stance::Support } else { Stance::Refute };
                    let cite = v.get_claim_evidence(cid).iter().find(|e| e.stance == want && (r >> 28) % 3 == 0).map(|e| e.id);
                    ctx(w, N / 40 + u128::from((r >> 32) % 300) * N / 1000, t);
                    v.buy(cid, side, U128(0), cite);
                }
                3 | 4 => {
                    let p = v.get_position(cid, acct(w));
                    let side = if p.yes.0 >= p.no.0 { Side::Yes } else { Side::No };
                    let held = if side == Side::Yes { p.yes.0 } else { p.no.0 };
                    if held >= TICK * 10 {
                        ctx(w, 0, t);
                        v.sell(cid, side, U128(held / (1 + u128::from((r >> 24) % 3))), U128(0));
                    }
                }
                5 | 6 | 7 => {
                    // post evidence where the contract would accept it (a refused call would leave a unit test half-applied)
                    let ev = v.get_claim_evidence(cid);
                    let mine = ev.iter().filter(|e| e.author == acct(w)).count();
                    let full = c.evidence.len() >= MAX_EVIDENCE_PER_CLAIM;
                    let room = !full || ev.iter().any(|e| e.bond_state == BondState::Forfeited);
                    if mine < MAX_EVIDENCE_PER_AUTHOR && room {
                        if full { evicted_at_full += 1; }
                        let count = c.evidence.len() as u128;
                        ctx(w, EVIDENCE_FEE_Y + EVIDENCE_FEE_Y * count / EVIDENCE_SURCHARGE_STEPS + MIN_BOND_Y + u128::from((r >> 24) % 3) * N / 100, t);
                        let stance = if (r >> 30) & 1 == 0 { Stance::Support } else { Stance::Refute };
                        v.post_evidence(cid, stance, format!("https://x.org/{posted}"), HASH.into(), String::new());
                        posted += 1;
                    }
                }
                8 => {
                    let total = v.get_config().evidence;
                    if total > 0 {
                        let id = (r >> 20) % total;
                        let e = v.get_evidence(id).unwrap();
                        if e.bond_state == BondState::Open && t * 1_000 >= e.posted_ms + 60_000 {
                            ctx("anyone.near", 0, t);
                            v.settle_bond(id);
                            settled += 1;
                        }
                    }
                }
                _ => {
                    if (r >> 40) % 2 == 0 {
                        if c.fee_pool.0 > 0 {
                            ctx("alice.near", 0, t);
                            v.withdraw_fees(cid);
                            withdrawn += 1;
                        }
                    } else {
                        let other = claims[((r >> 44) % 4) as usize];
                        let key = (cid.min(other), cid.max(other));
                        if cid != other && !linked.contains(&key) && v.get_claim(cid).unwrap().links.len() < MAX_LINKS_PER_CLAIM {
                            ctx("bob.near", CLAIM_FEE_Y + N, t);
                            v.create_link(key.0, key.1, Rel::Excludes, 9_000);
                            linked.insert(key);
                            links_made += 1;
                        }
                    }
                }
            }
            audit(&v);
        }
        println!("mixed walk: {posted} evidence ({evicted_at_full} at a full claim), {settled} bonds settled, {withdrawn} fee withdrawals, {links_made} links");
        assert!(posted > 100 && settled > 20 && withdrawn > 5, "the walk must actually exercise every operation");
    }


    #[test]
    fn evidence_can_be_read_in_pages() {
        let mut v = fresh();
        let id = seed_claim(&mut v, 5_000);
        for i in 0..5 {
            post(&mut v, &format!("res{i}.near"), id, i, 3);
        }
        assert_eq!(v.get_evidence_page(0, None).len(), 5);
        assert_eq!(v.get_evidence_page(3, None).iter().map(|e| e.id).collect::<Vec<_>>(), vec![3, 4]);
        assert_eq!(v.get_evidence_page(0, Some(2)).len(), 2);
        assert!(v.get_evidence_page(9, None).is_empty());
    }

}
