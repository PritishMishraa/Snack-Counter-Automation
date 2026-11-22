# Snack Counter Automation: Design

**Scope:** Oslo (≈15 volunteers, 6 000 NOK/month) and Bengaluru (≈20 volunteers, 15 000 INR/month).
**Code:** TypeScript, `src/`. **Tests:** `tests/` (65). **Try it:** [live simulation](index.html). **Source:** [github.com/PritishMishraa/Snack-Counter-Automation](https://github.com/PritishMishraa/Snack-Counter-Automation).

## 1. What "automate" means here

A **chat bot that owns every refill from "empty" to "reimbursed"**. People still buy the snacks and HR still approves
claims. The bot handles the coordination, which is the part that currently fails: it picks exactly one buyer, gives
them a budget and a deadline, files the HR claim for them, chases the claim, and sends management one report a month.

It runs inside the chat tool everyone already uses (slash commands and buttons), so there is no new app, login or habit.

## 2. How a refill moves from "empty" to "reimbursed"

```
 /snack empty ─▶ AWAITING_VOLUNTEER ──"Yes"──▶ COMMITTED ──"/snack bought"──▶ PURCHASED ──▶ CLAIM_SUBMITTED ──▶ REIMBURSED
                   │  ▲   ▲                        │                ▲  │ over limit         (HR: 1–10 days)  └─▶ CLAIM_REJECTED
                   │  │   └── 24 h deadline lapses ┘   admin approves └──▶ NEEDS_APPROVAL
                   │  └── offer expires / declined: ask the next person
                   └── budget used up ─▶ ON_HOLD_BUDGET ── resumes at the start of next month
```

1. **Report.** Anyone types `/snack empty`. If the office already has an open refill, they're told who is on it. There is never a second refill.
2. **Offer.** The bot checks the budget, ranks the volunteers who can refill today (§4), and DMs the top one: *"Could you refill today? Up to 1 200 NOK. [Yes] [Can't today]"*. No answer within **2 h**, or a decline, and the next person is asked. After **3** direct offers it posts to the office channel; if that sits **4 h**, it re-posts and alerts the office admin. Anyone may press "Yes" at any point.
3. **Commit.** The first "Yes" wins atomically. The buyer gets a **spend limit** (reserved against the budget) and a **24 h deadline**. The channel is told *"Ada is refilling. Please don't buy"*.
4. **Buy.** `/snack bought R-OSL-7 845.50 <receipt> chips, fruit`. If the amount is within the limit, the claim goes straight to HR. If it's over, an admin approves or rejects it first.
5. **Claim.** The bot sends HR the amount, currency, description, receipt and employee ID, and tells the buyer the claim ID. It polls HR, DMs the buyer on approval or rejection, retries if HR is down, and chases any claim older than 10 days.
6. **Missed deadline.** A reminder goes out 6 h before the deadline. When the deadline passes, the reservation is released and the next person is asked. If the late buyer did buy, they can still report it, but only until someone else commits.

## 3. Main parts and the data each keeps

| Part | Responsibility | Data it keeps |
|---|---|---|
| **Chat adapter** (`ChatPort`, `chat/commands.ts`) | Parses `/snack …` commands and buttons; sends DMs and channel posts | None |
| **Refill service** (`core/refill-service.ts`) | The state machine above; the only writer of refills | `Refill`: status, version, reporter, current offer, people passed over, commitment (buyer, deadline, spend limit, budget month), purchase (amount, receipt, items), claim reference, full event history |
| **Buyer selection** (`core/selection.ts`) | Ranks who to ask. Pure function | None (computed from refills and presence) |
| **Budget** (`core/budget.ts`) | Spent / reserved / remaining per office per month; decides the spend limit. Pure | None (derived from refills, so it can't drift) |
| **Directory** (`store/directory.ts`) | Offices, volunteer roster, presence | `Office` (currency, time zone, budget, purchase range, channel, admins), `Volunteer` (home office, active), usual office weekdays per person, and day entries (in office X / remote / holiday) that override the pattern |
| **HR adapter** (`HrPort`) | Creates claims and reads their status | Claim ID stored on the refill |
| **Scheduler** (`tick()`, every few minutes) | Expires offers, sends reminders, lapses commitments, lifts budget holds, retries and polls HR | None |
| **Report** (`core/report.ts`) | Monthly management report across both offices | None (derived) + monthly FX rate table |

The refill record is the single source of truth. Budget, fairness and the report are all derived from it, so they cannot
disagree with each other. A test checks that the report and the live budget figure match.

## 4. How each problem is prevented

| Problem | Mechanism |
|---|---|
| **Box sits empty; everyone assumes someone else** | A named person is asked directly instead of "someone". Silence counts as a "no" after 2 h, then it escalates to the channel and the admin. The report shows average hours the box was empty. |
| **Two people buy on the same day** | One active refill per office (atomic insert). Commit is a compare-and-set on a version number, so exactly one of N simultaneous "Yes" presses wins and the rest are told *"X got there first"*. A purchase is only accepted from the committed buyer. Whoever is currently being asked, or whose deadline lapsed, is told *"don't buy"*. |
| **A few people do most refills** | Ranking: (1) checked in at this office today, (2) **fewest refills in the last 30 days**, (3) longest since their last refill. The DM tells people why they were picked. The report lists refills per person. |
| **…and wait weeks for their money** | The claim is filed the moment the receipt is posted; no forms. The bot polls HR, retries outages, and chases claims older than 10 days. Anyone with **2 unreimbursed claims isn't asked again** until one clears. |
| **Nobody knows monthly spend** | Live `/snack status` per office; an automatic monthly report gives spend vs budget per office in local currency plus one converted total. |
| **…or which snacks get eaten** | Buyers tag items when reporting a purchase (`chips, fruit`). The report shows the top items and how fast the box empties. |
| **Overspending** | Each buyer gets a spend limit = min(1 200 NOK / 3 000 INR, what's left). It's reserved at commit, so "remaining" always includes money that's about to be spent. If less than a minimum purchase is left, the refill waits for next month. |
| **Hybrid work, holidays, visitors** | Set once, not daily: usual office days (`/snack days mon,wed,thu`), a whole trip (`/snack visiting oslo 2026-11-09 2026-11-20`), or a holiday (`/snack holiday from to`). `/snack here` / `/snack remote` override a single day. People on holiday, working remotely, or in the other city are skipped. A visitor is asked where they *are*, not at home; they buy and are claimed in NOK, it's charged to Oslo's budget, and HR pays them in INR. |

## 5. Trade-offs and what I deliberately would not build

**Trade-offs made**
- **Ask one person first instead of a free-for-all.** Slower than broadcasting (up to 6 h of direct offers), but it creates ownership and fairness. Mitigation: anyone can still step in at any time.
- **Each office's budget is kept in its own currency.** The budget check never needs an exchange rate, which is exact and simple. FX is only used in the management report, once per office total at a monthly rate, so rounding doesn't build up per receipt.
- **Self-reported presence instead of calendar or badge integration.** One weekly pattern plus trips and holidays covers hybrid work with almost no effort. Anyone who never sets one counts as "maybe", not "no", and the 2 h timeout limits the cost of asking someone who is absent.
- **Over-limit receipts count as spent while in review.** The money is already out of someone's pocket. Hiding it would make the budget look healthier than it is.
- **HR "approved" counts as "reimbursed".** We can't see payroll, and HR owns conversion to the payroll currency.
- **Polling HR instead of webhooks.** The brief doesn't say HR offers callbacks; polling works with any HR system.
- **Save state, then notify.** Nobody is told something that didn't happen. A crash between the two loses a message (fixable with an outbox table).

**Deliberately not built**
- Stock or inventory tracking, sensors, or a snack-voting system. "Box empty" plus item tags answers the question for a fraction of the effort.
- Receipt OCR. The buyer types the amount and HR checks it against the image anyway.
- A company card or paying volunteers directly. That would remove the out-of-pocket problem, but it's a finance-policy change, not software. I'd recommend it as a follow-up.
- A web dashboard. The monthly report and `/snack status` cover what's needed today.
- A rota or calendar sync. Fair-share ranking does the same job without anyone maintaining a schedule.
- Working-day calendars and public holidays. Deadlines are 24 h wall-clock, and a weekend deadline just moves the refill on.
