# Snack Counter Automation

Automates keeping the Oslo and Bengaluru snack counters stocked: it picks exactly one buyer per refill, fairly;
enforces each office's monthly budget; files and chases the HR reimbursement claim; and produces one monthly report
across both currencies. People interact with it through the company chat tool.

- **Live simulation:** [docs/index.html](docs/index.html). Open it in a browser; it runs the real core logic, no server needed.
- **Design doc:** [docs/design.html](docs/design.html) (prints to 2 A4 pages) · [docs/DESIGN.md](docs/DESIGN.md) (same content, Markdown)
## Run it

```bash
npm install
npm test          # 65 tests
npm run typecheck
npm run demo      # a scripted month at both offices, printed as the chat transcript
npm run web       # rebuild the browser bundle and open the live simulation
```

Requires Node 20+. No runtime dependencies.

The simulation has one-click scenarios, which you can also open directly by URL:
`docs/index.html#scenario=race` (two people tap "Yes" at once), `#scenario=silence` (nobody answers), `#scenario=lapse`
(buyer forgets), `#scenario=visitor` (two-week visit), `#scenario=budget` (budget runs out), `#scenario=overLimit`,
and `#scenario=month` (simulates all of November, then shows the report).

## Layout

```
src/
  domain/          money (integer minor units), time zones, the data model, errors
  core/
    refill-service.ts   the refill lifecycle (state machine) + scheduler tick
    selection.ts        choosing who buys (pure)
    budget.ts           the budget check (pure)
    report.ts           monthly management report across currencies
    policy.ts           tunable timeouts and limits
  chat/commands.ts    /snack slash-commands and buttons → service calls
  ports.ts            interfaces to the chat tool, HR system, clock, FX rates
  fakes/              simulated chat tool, HR system, clock, FX rates
  store/              in-memory refill store (optimistic concurrency) + directory/presence
  app.ts              wiring
  demo.ts             CLI simulation
web/main.ts         browser simulation UI (bundled into docs/demo.js)
tests/              Vitest specs, one file per area
docs/               design doc, decision log, live simulation (GitHub Pages-ready)
```

## Where the brief's rules are proven

| Rule | Test |
|---|---|
| Two people cannot both commit to the same refill | `lifecycle.test.ts` › *two people cannot both commit…* (incl. 5 simultaneous commits → exactly 1 winner) |
| Only one refill per office at a time, even with simultaneous reports | `lifecycle.test.ts` › *simultaneous empty reports create exactly one refill* |
| A refill nobody completes is handed to someone else | `lifecycle.test.ts` › *a refill nobody completes…* (offer timeout, decline, missed deadline, broadcast, escalation) |
| Budgets and totals are correct across both currencies | `report.test.ts` (NOK + INR totals, conversion of totals only, rejected excluded, matches live budget), `budget.test.ts` |
| Spend limit, reservation, on-hold, month rollover per time zone | `budget.test.ts` |
| Fair choice of buyer, open-claims cap | `selection.test.ts` |
| Hybrid work (weekly patterns, overrides), holidays, 1–2 week visits | `selection.test.ts`, `commands.test.ts` |
| HR outage retry, rejection, 10-day chase, scheduler isolation | `lifecycle.test.ts` › *reimbursement follow-up* |
| Chat commands end to end | `commands.test.ts` |

## Chat commands

```
/snack empty [office]            report the box as empty
/snack yes <refill>              commit to buying          (also a button)
/snack no <refill>               decline an offer          (also a button)
/snack release <refill>          give back a refill you committed to
/snack bought <refill> <amount> <receipt-url> [item, item, ...]
/snack days mon,wed,thu          my usual office days ("none" to clear)
/snack visiting <office> <from> [to]   a trip to the other office
/snack holiday <from> [to]
/snack here [office] | remote    override just today
/snack status [office]
/snack approve <refill> | reject <refill> <reason> | cancel <refill> <reason>   (admins)
```
