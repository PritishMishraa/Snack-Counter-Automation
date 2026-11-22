"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key2, value) => key2 in obj ? __defProp(obj, key2, { enumerable: true, configurable: true, writable: true, value }) : obj[key2] = value;
  var __publicField = (obj, key2, value) => __defNormalProp(obj, typeof key2 !== "symbol" ? key2 + "" : key2, value);

  // src/domain/errors.ts
  var DomainError = class extends Error {
    constructor(code, message) {
      super(message);
      __publicField(this, "code", code);
      this.name = "DomainError";
    }
  };

  // src/domain/money.ts
  var MINOR_PER_MAJOR = 100;
  function money(major, currency) {
    if (!Number.isFinite(major)) throw new DomainError("INVALID_AMOUNT", `Amount must be a finite number, got ${major}`);
    return { minor: Math.round(major * MINOR_PER_MAJOR), currency };
  }
  function fromMinor(minor, currency) {
    if (!Number.isSafeInteger(minor)) throw new DomainError("INVALID_AMOUNT", `Minor units must be an integer, got ${minor}`);
    return { minor, currency };
  }
  function zero(currency) {
    return { minor: 0, currency };
  }
  function assertSameCurrency(a, b) {
    if (a.currency !== b.currency) {
      throw new DomainError("CURRENCY_MISMATCH", `Cannot combine ${a.currency} with ${b.currency} without conversion`);
    }
  }
  function add(a, b) {
    assertSameCurrency(a, b);
    return { minor: a.minor + b.minor, currency: a.currency };
  }
  function subtract(a, b) {
    assertSameCurrency(a, b);
    return { minor: a.minor - b.minor, currency: a.currency };
  }
  function sum(items, currency) {
    return items.reduce((acc, m) => add(acc, m), zero(currency));
  }
  function min(a, b) {
    assertSameCurrency(a, b);
    return a.minor <= b.minor ? a : b;
  }
  function compare(a, b) {
    assertSameCurrency(a, b);
    return a.minor - b.minor;
  }
  function format(m) {
    const sign = m.minor < 0 ? "-" : "";
    const abs = Math.abs(m.minor);
    const major = Math.floor(abs / MINOR_PER_MAJOR);
    const rest = String(abs % MINOR_PER_MAJOR).padStart(2, "0");
    return `${sign}${major.toLocaleString("en-US")}.${rest} ${m.currency}`;
  }
  function toDecimalString(m) {
    const sign = m.minor < 0 ? "-" : "";
    const abs = Math.abs(m.minor);
    return `${sign}${Math.floor(abs / MINOR_PER_MAJOR)}.${String(abs % MINOR_PER_MAJOR).padStart(2, "0")}`;
  }
  function convert(m, to, rate) {
    if (m.currency === to) return m;
    if (!(rate > 0)) throw new DomainError("INVALID_RATE", `Exchange rate ${m.currency}->${to} must be positive`);
    const raw = m.minor * rate;
    const rounded = Math.sign(raw) * Math.round(Math.abs(raw));
    return { minor: rounded, currency: to };
  }

  // src/domain/time.ts
  var MINUTE = 6e4;
  var HOUR = 60 * MINUTE;
  var DAY = 24 * HOUR;
  var formatters = /* @__PURE__ */ new Map();
  function formatterFor(timeZone) {
    let f = formatters.get(timeZone);
    if (!f) {
      f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
      formatters.set(timeZone, f);
    }
    return f;
  }
  function localDate(instant, timeZone) {
    return formatterFor(timeZone).format(instant);
  }
  var hourFormatters = /* @__PURE__ */ new Map();
  function localHour(instant, timeZone) {
    let f = hourFormatters.get(timeZone);
    if (!f) {
      f = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" });
      hourFormatters.set(timeZone, f);
    }
    return Number(f.format(instant));
  }
  function localMonth(instant, timeZone) {
    return localDate(instant, timeZone).slice(0, 7);
  }
  function weekdayOf(date) {
    return (/* @__PURE__ */ new Date(`${date}T12:00:00Z`)).getUTCDay();
  }
  function datesBetween(from, to) {
    const out = [];
    const end = Date.parse(`${to}T00:00:00Z`);
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length <= 366; t += DAY) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }
  function formatLocal(instant, timeZone) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(instant);
  }
  function addMs(instant, ms) {
    return new Date(instant.getTime() + ms);
  }
  function hoursBetween(from, to) {
    return (to.getTime() - from.getTime()) / HOUR;
  }

  // src/chat/commands.ts
  var HELP = [
    "/snack empty [office]            report the box as empty",
    "/snack yes <refill>              commit to buying",
    "/snack no <refill>               decline an offer",
    "/snack release <refill>          give back a refill you committed to",
    "/snack bought <refill> <amount> <receipt-url> [item, item, ...]",
    "/snack here [office]             I am in this office today",
    "/snack remote                    I am working from home today",
    "/snack holiday <from> [to]       dates as YYYY-MM-DD",
    "/snack visiting <office> <from> [to]   a trip to the other office",
    '/snack days mon,wed,thu          my usual office days ("none" to clear)',
    "/snack status [office]",
    "/snack approve <refill> | reject <refill> <reason> | cancel <refill> <reason>   (admins)"
  ].join("\n");
  var ChatCommands = class {
    constructor(service, directory, clock) {
      __publicField(this, "service", service);
      __publicField(this, "directory", directory);
      __publicField(this, "clock", clock);
    }
    async handle(from, text) {
      const [prefix, command = "help", ...args] = text.trim().split(/\s+/);
      if (prefix !== "/snack") return HELP;
      try {
        return await this.dispatch(from, command.toLowerCase(), args);
      } catch (e) {
        if (e instanceof DomainError) return e.message;
        throw e;
      }
    }
    async dispatch(from, command, args) {
      switch (command) {
        case "empty": {
          const office = args[0] ? this.resolveOffice(args[0]) : this.currentOffice(from);
          const { refill, created } = await this.service.reportEmpty(office.id, from);
          return created ? `Thanks, refill ${refill.id} started for ${office.name}.` : `Already being handled (${refill.id}).`;
        }
        case "yes":
          await this.service.commit(requireArg(args, 0, "refill id"), from);
          return "Great, it is yours. Check your direct messages for the budget and deadline.";
        case "no":
          await this.service.decline(requireArg(args, 0, "refill id"), from);
          return "No problem, I'll ask someone else.";
        case "release":
          await this.service.release(requireArg(args, 0, "refill id"), from);
          return "Released. I'll find someone else.";
        case "bought": {
          const refillId = requireArg(args, 0, "refill id");
          const refill = await this.service.get(refillId);
          const office = this.directory.office(refill.officeId);
          const amount = parseAmount(requireArg(args, 1, "amount"));
          const receipt = requireArg(args, 2, "receipt");
          const items = args.slice(3).join(" ").split(",").map((s) => s.trim()).filter(Boolean);
          const updated = await this.service.recordPurchase(refillId, from, {
            amount: fromMinor(amount, office.currency),
            receiptImage: receipt,
            items
          });
          return updated.status === "NEEDS_APPROVAL" ? "Recorded. It is above the limit, so an admin will review it first." : "Recorded, thank you! Your reimbursement claim has been filed.";
        }
        case "here": {
          const office = args[0] ? this.resolveOffice(args[0]) : this.homeOffice(from);
          this.directory.setPresence(from, this.today(office), { kind: "office", officeId: office.id });
          return `Noted: you're in ${office.name} today.`;
        }
        case "remote": {
          const office = this.homeOffice(from);
          this.directory.setPresence(from, this.today(office), { kind: "remote" });
          return "Noted: you're remote today. I won't ask you to refill.";
        }
        case "holiday": {
          const [fromDate, toDate] = parseRange(args[0], args[1]);
          this.directory.setPresenceRange(from, fromDate, toDate, { kind: "holiday" });
          return `Enjoy! I won't ask you to refill from ${fromDate} to ${toDate}.`;
        }
        case "visiting": {
          const office = this.resolveOffice(requireArg(args, 0, "office"));
          const [fromDate, toDate] = parseRange(args[1], args[2]);
          this.directory.setPresenceRange(from, fromDate, toDate, { kind: "office", officeId: office.id });
          const home = this.homeOffice(from);
          return office.id === home.id ? `Noted: you're in ${office.name} from ${fromDate} to ${toDate}.` : `Have a good trip! From ${fromDate} to ${toDate} I may ask you to help in ${office.name}, and won't ask you in ${home.name}.`;
        }
        case "days": {
          const days = parseWeekdays(requireArg(args, 0, "days, e.g. mon,wed,thu"));
          this.directory.setOfficeDays(from, days);
          return days === null ? "Cleared your usual office days." : `Noted: you're usually in the office on ${days.map((d) => capitalise(WEEKDAYS[d])).join(", ")}. Use /snack here or /snack remote to override a single day.`;
        }
        case "status": {
          const office = args[0] ? this.resolveOffice(args[0]) : this.currentOffice(from);
          return this.service.status(office.id);
        }
        case "approve":
          await this.service.approvePurchase(requireArg(args, 0, "refill id"), from);
          return "Approved. The claim has been filed.";
        case "reject":
          await this.service.rejectPurchase(requireArg(args, 0, "refill id"), from, args.slice(1).join(" ") || "no reason given");
          return "Rejected. The buyer has been told.";
        case "cancel":
          await this.service.cancel(requireArg(args, 0, "refill id"), from, args.slice(1).join(" ") || "no reason given");
          return "Cancelled.";
        case "help":
          return HELP;
        default:
          throw new DomainError("UNKNOWN_COMMAND", `Unknown command "${command}".
${HELP}`);
      }
    }
    /** Where the person is today: the office they checked into, otherwise their home office. */
    currentOffice(employeeId) {
      for (const office of this.directory.listOffices()) {
        const p = this.directory.presenceOn(employeeId, this.today(office));
        if (p?.kind === "office") return this.directory.office(p.officeId);
      }
      return this.homeOffice(employeeId);
    }
    homeOffice(employeeId) {
      return this.directory.office(this.directory.requireVolunteer(employeeId).homeOfficeId);
    }
    resolveOffice(input) {
      const needle = input.toLowerCase();
      const match = this.directory.listOffices().find((o) => o.id.toLowerCase() === needle || o.name.toLowerCase() === needle);
      if (!match) throw new DomainError("NOT_FOUND", `Unknown office "${input}".`);
      return match;
    }
    today(office) {
      return localDate(this.clock.now(), office.timeZone);
    }
  };
  function requireArg(args, i, what) {
    const v = args[i];
    if (!v) throw new DomainError("INVALID_STATE", `Missing ${what}.
${HELP}`);
    return v;
  }
  function parseAmount(input) {
    const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(input);
    if (!m) throw new DomainError("INVALID_AMOUNT", `"${input}" is not a valid amount. Use e.g. 450 or 450.50.`);
    return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  }
  function parseDate(input) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || Number.isNaN(Date.parse(`${input}T00:00:00Z`))) {
      throw new DomainError("INVALID_STATE", `"${input}" is not a date. Use YYYY-MM-DD.`);
    }
    return input;
  }
  function parseRange(fromArg, toArg) {
    const from = parseDate(fromArg ?? "");
    const to = toArg ? parseDate(toArg) : from;
    if (to < from) throw new DomainError("INVALID_STATE", "The end date is before the start date.");
    return [from, to];
  }
  var WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  function capitalise(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function parseWeekdays(input) {
    if (input.toLowerCase() === "none") return null;
    const days = input.toLowerCase().split(",").map((s) => s.trim().slice(0, 3)).filter(Boolean);
    const out = days.map((d) => {
      const i = WEEKDAYS.indexOf(d);
      if (i < 0) throw new DomainError("INVALID_STATE", `"${d}" is not a weekday. Use e.g. mon,wed,thu.`);
      return i;
    });
    return [...new Set(out)].sort();
  }

  // src/config.ts
  var OFFICES = [
    {
      id: "OSL",
      name: "Oslo",
      currency: "NOK",
      timeZone: "Europe/Oslo",
      monthlyBudget: money(6e3, "NOK"),
      maxPurchase: money(1200, "NOK"),
      minPurchase: money(300, "NOK"),
      channel: "#snacks-oslo",
      admins: ["osl-admin"]
    },
    {
      id: "BLR",
      name: "Bengaluru",
      currency: "INR",
      timeZone: "Asia/Kolkata",
      monthlyBudget: money(15e3, "INR"),
      maxPurchase: money(3e3, "INR"),
      minPurchase: money(500, "INR"),
      channel: "#snacks-bengaluru",
      admins: ["blr-admin"]
    }
  ];

  // src/core/policy.ts
  var DEFAULT_POLICY = {
    offerTimeoutMs: 2 * HOUR,
    maxDirectOffers: 3,
    broadcastTimeoutMs: 4 * HOUR,
    commitWindowMs: 24 * HOUR,
    reminderLeadMs: 6 * HOUR,
    maxOpenClaimsPerVolunteer: 2,
    fairnessWindowMs: 30 * DAY,
    claimOverdueMs: 10 * DAY,
    claimAttemptsBeforeEscalation: 3,
    officeHours: { start: 8, end: 18, days: [1, 2, 3, 4, 5] }
  };

  // src/domain/model.ts
  var ACTIVE_STATUSES = /* @__PURE__ */ new Set(["AWAITING_VOLUNTEER", "ON_HOLD_BUDGET", "COMMITTED"]);
  var SPENT_STATUSES = /* @__PURE__ */ new Set([
    "NEEDS_APPROVAL",
    "PURCHASED",
    "CLAIM_SUBMITTED",
    "REIMBURSED"
  ]);

  // src/core/budget.ts
  function budgetPosition(office, month, refills) {
    const own = refills.filter((r) => r.officeId === office.id);
    const spent = sum(
      own.filter((r) => SPENT_STATUSES.has(r.status) && r.purchase?.budgetMonth === month).map((r) => r.purchase.amount),
      office.currency
    );
    const reserved = sum(
      own.filter((r) => r.status === "COMMITTED" && r.commitment?.budgetMonth === month).map((r) => r.commitment.spendLimit),
      office.currency
    );
    const remaining = subtract(subtract(office.monthlyBudget, spent), reserved);
    return { month, budget: office.monthlyBudget, spent, reserved, remaining };
  }
  function decideSpendLimit(office, position) {
    const remaining = position.remaining.minor > 0 ? position.remaining : zero(office.currency);
    if (compare(remaining, office.minPurchase) < 0) return { ok: false, remaining };
    return { ok: true, spendLimit: min(office.maxPurchase, remaining) };
  }

  // src/core/selection.ts
  var OPEN_CLAIM_STATUSES = /* @__PURE__ */ new Set(["NEEDS_APPROVAL", "PURCHASED", "CLAIM_SUBMITTED"]);
  function rankCandidates(input) {
    const { office, today, now, policy } = input;
    const windowStart = now.getTime() - policy.fairnessWindowMs;
    const busy = new Set(
      input.refills.filter((r) => r.status === "COMMITTED" && r.commitment).map((r) => r.commitment.buyer)
    );
    const candidates = [];
    for (const v of input.volunteers) {
      if (!v.active || input.exclude.has(v.employeeId) || busy.has(v.employeeId)) continue;
      const tier = presenceTier(input.presenceOn(v.employeeId, today), v, office);
      if (tier === void 0) continue;
      const bought = input.refills.filter((r) => r.purchase?.buyer === v.employeeId);
      const openClaims = bought.filter((r) => OPEN_CLAIM_STATUSES.has(r.status)).length;
      if (openClaims >= policy.maxOpenClaimsPerVolunteer) continue;
      const recent = bought.filter((r) => r.purchase.purchasedAt.getTime() >= windowStart);
      const lastRefillAt = bought.reduce(
        (latest, r) => !latest || r.purchase.purchasedAt > latest ? r.purchase.purchasedAt : latest,
        void 0
      );
      candidates.push({ employeeId: v.employeeId, tier, recentRefills: recent.length, lastRefillAt, openClaims });
    }
    return candidates.sort(
      (a, b) => a.tier - b.tier || a.recentRefills - b.recentRefills || (a.lastRefillAt?.getTime() ?? 0) - (b.lastRefillAt?.getTime() ?? 0) || a.employeeId.localeCompare(b.employeeId)
    );
  }
  function presenceTier(status, v, office) {
    if (status === void 0) return v.homeOfficeId === office.id ? 1 : void 0;
    if (status.kind === "office") return status.officeId === office.id ? 0 : void 0;
    return void 0;
  }

  // src/core/refill-service.ts
  var RefillService = class {
    constructor(d) {
      __publicField(this, "d", d);
      __publicField(this, "claimsInFlight", /* @__PURE__ */ new Set());
    }
    // ─── Commands (called from chat) ────────────────────────────────────────────
    async reportEmpty(officeId, reportedBy) {
      const office = this.d.directory.office(officeId);
      const now = this.d.clock.now();
      const draft = {
        id: this.d.ids.next(`R-${office.id}`),
        officeId: office.id,
        status: "AWAITING_VOLUNTEER",
        version: 1,
        reportedBy,
        reportedAt: now,
        directOffers: 0,
        passedOver: [],
        claimAttempts: 0,
        escalated: false,
        history: [{ at: now, type: "REPORTED_EMPTY", by: reportedBy }]
      };
      const result = await this.d.store.insertIfNoActive(draft);
      if (!result.inserted) {
        await this.d.chat.sendDirect(reportedBy, `Thanks! ${this.describe(result.existing)}`);
        return { refill: result.existing, created: false };
      }
      await this.d.chat.postToChannel(
        office.channel,
        `The ${office.name} snack box was reported empty by ${this.name(reportedBy)}. Finding someone to refill it.`
      );
      return { refill: await this.findBuyer(result.refill), created: true };
    }
    async commit(refillId, employeeId) {
      this.d.directory.requireVolunteer(employeeId);
      const refill = await this.load(refillId);
      if (refill.status === "COMMITTED") {
        if (refill.commitment.buyer === employeeId) return refill;
        throw new DomainError("ALREADY_TAKEN", `${this.name(refill.commitment.buyer)} is already refilling this one. No need to buy.`);
      }
      if (refill.status === "ON_HOLD_BUDGET") {
        throw new DomainError("BUDGET_EXCEEDED", "This month's snack budget is used up, so the refill resumes next month. Please don't buy.");
      }
      if (refill.status !== "AWAITING_VOLUNTEER") {
        throw new DomainError("INVALID_STATE", `This refill is no longer looking for a buyer (${refill.status}).`);
      }
      const office = this.d.directory.office(refill.officeId);
      const position = await this.budget(office);
      const decision = decideSpendLimit(office, position);
      if (!decision.ok) {
        await this.findBuyer(refill);
        throw new DomainError("BUDGET_EXCEEDED", `Only ${format(decision.remaining)} left this month, so this refill is on hold.`);
      }
      const now = this.d.clock.now();
      let next;
      try {
        next = await this.write(
          refill,
          {
            status: "COMMITTED",
            offer: void 0,
            lapsedBuyer: void 0,
            commitment: {
              buyer: employeeId,
              committedAt: now,
              dueAt: addMs(now, this.d.policy.commitWindowMs),
              spendLimit: decision.spendLimit,
              budgetMonth: position.month,
              reminderSent: false
            }
          },
          "COMMITTED",
          employeeId
        );
      } catch (e) {
        if (!(e instanceof DomainError && e.code === "CONCURRENT_UPDATE")) throw e;
        const latest = await this.load(refillId);
        if (latest.status === "COMMITTED" && latest.commitment.buyer === employeeId) return latest;
        if (latest.status === "COMMITTED") {
          throw new DomainError("ALREADY_TAKEN", `${this.name(latest.commitment.buyer)} got there first. No need to buy.`);
        }
        throw new DomainError("CONCURRENT_UPDATE", "The refill changed while you were answering. Please try again.");
      }
      const c = next.commitment;
      await this.d.chat.sendDirect(
        employeeId,
        `You're on it, thank you! Spend up to ${format(c.spendLimit)} and report it by ${this.when(c.dueAt, office)} with "/snack bought ${next.id} <amount> <receipt>". The claim is filed for you automatically.`
      );
      await this.d.chat.postToChannel(office.channel, `${this.name(employeeId)} is refilling the snack box. Please don't buy.`);
      const offeredTo = refill.offer?.to;
      if (offeredTo && offeredTo !== employeeId) {
        await this.d.chat.sendDirect(offeredTo, `Never mind, ${this.name(employeeId)} picked up refill ${next.id}.`);
      }
      if (refill.lapsedBuyer && refill.lapsedBuyer !== employeeId) {
        await this.d.chat.sendDirect(
          refill.lapsedBuyer,
          `${this.name(employeeId)} has taken over refill ${next.id}. Please don't buy for it now.`
        );
      }
      return next;
    }
    async decline(refillId, employeeId) {
      const refill = await this.load(refillId);
      if (refill.status !== "AWAITING_VOLUNTEER" || refill.passedOver.includes(employeeId)) return refill;
      const next = await this.write(refill, { passedOver: [...refill.passedOver, employeeId] }, "DECLINED", employeeId);
      return refill.offer?.to === employeeId ? this.findBuyer(next) : next;
    }
    async recordPurchase(refillId, employeeId, input) {
      const refill = await this.load(refillId);
      const office = this.d.directory.office(refill.officeId);
      if (input.amount.currency !== office.currency) {
        throw new DomainError("CURRENCY_MISMATCH", `${office.name} refills are bought and claimed in ${office.currency}.`);
      }
      if (input.amount.minor <= 0) throw new DomainError("INVALID_AMOUNT", "The amount must be positive.");
      if (!input.receiptImage.trim()) throw new DomainError("NOT_ALLOWED", "A receipt image is required for reimbursement.");
      let limit;
      let budgetMonth;
      if (refill.status === "COMMITTED" && refill.commitment.buyer === employeeId) {
        limit = refill.commitment.spendLimit;
        budgetMonth = refill.commitment.budgetMonth;
      } else if (refill.status === "AWAITING_VOLUNTEER" && refill.lapsedBuyer === employeeId) {
        const position = await this.budget(office);
        const decision = decideSpendLimit(office, position);
        limit = decision.ok ? decision.spendLimit : zero(office.currency);
        budgetMonth = position.month;
      } else if (refill.status === "COMMITTED") {
        throw new DomainError("NOT_ALLOWED", `${this.name(refill.commitment.buyer)} is the buyer for this refill.`);
      } else {
        throw new DomainError("INVALID_STATE", `You can only report a purchase for a refill you committed to (${refill.status}).`);
      }
      const overLimit = compare(input.amount, limit) > 0;
      const next = await this.write(
        refill,
        {
          status: overLimit ? "NEEDS_APPROVAL" : "PURCHASED",
          offer: void 0,
          lapsedBuyer: void 0,
          purchase: {
            buyer: employeeId,
            amount: input.amount,
            receiptImage: input.receiptImage,
            items: normaliseItems(input.items ?? []),
            purchasedAt: this.d.clock.now(),
            budgetMonth
          }
        },
        overLimit ? "PURCHASED_OVER_LIMIT" : "PURCHASED",
        employeeId,
        format(input.amount)
      );
      await this.d.chat.postToChannel(office.channel, `The snack box has been refilled by ${this.name(employeeId)}. Thanks!`);
      const offeredTo = refill.offer?.to;
      if (offeredTo && offeredTo !== employeeId) {
        await this.d.chat.sendDirect(offeredTo, `Never mind, ${this.name(employeeId)} already refilled ${next.id}.`);
      }
      if (overLimit) {
        await this.d.chat.sendDirect(
          employeeId,
          `Your receipt (${format(input.amount)}) is above the ${format(limit)} limit, so an admin will review it before the claim is filed.`
        );
        await this.notifyAdmins(
          office,
          `Refill ${next.id}: ${this.name(employeeId)} spent ${format(input.amount)}, above the ${format(limit)} limit.`,
          [
            { label: "Approve", command: `/snack approve ${next.id}` },
            { label: "Reject", command: `/snack reject ${next.id} <reason>` }
          ]
        );
        return next;
      }
      return this.submitClaim(next);
    }
    async approvePurchase(refillId, adminId) {
      const refill = await this.load(refillId);
      this.requireAdmin(refill, adminId);
      if (refill.status !== "NEEDS_APPROVAL") throw new DomainError("INVALID_STATE", `Refill ${refillId} is not awaiting approval.`);
      const next = await this.write(refill, { status: "PURCHASED" }, "APPROVED_OVER_LIMIT", adminId);
      return this.submitClaim(next);
    }
    async rejectPurchase(refillId, adminId, reason) {
      const refill = await this.load(refillId);
      this.requireAdmin(refill, adminId);
      if (refill.status !== "NEEDS_APPROVAL") throw new DomainError("INVALID_STATE", `Refill ${refillId} is not awaiting approval.`);
      const next = await this.write(refill, { status: "CLAIM_REJECTED" }, "REJECTED_OVER_LIMIT", adminId, reason);
      await this.d.chat.sendDirect(next.purchase.buyer, `Your over-limit receipt for ${next.id} was not approved: ${reason}`);
      return next;
    }
    /** False alarm, or an admin closing a stuck refill. */
    async cancel(refillId, by, reason) {
      const refill = await this.load(refillId);
      const office = this.d.directory.office(refill.officeId);
      if (!ACTIVE_STATUSES.has(refill.status)) throw new DomainError("INVALID_STATE", `Refill ${refillId} can no longer be cancelled.`);
      if (by !== refill.reportedBy && !office.admins.includes(by)) {
        throw new DomainError("NOT_ALLOWED", "Only the reporter or an office admin can cancel a refill.");
      }
      const next = await this.write(refill, { status: "CANCELLED", offer: void 0 }, "CANCELLED", by, reason);
      if (refill.commitment) await this.d.chat.sendDirect(refill.commitment.buyer, `Refill ${refill.id} was cancelled (${reason}). Please don't buy.`);
      await this.d.chat.postToChannel(office.channel, `Refill ${refill.id} was cancelled: ${reason}`);
      return next;
    }
    async get(refillId) {
      return this.load(refillId);
    }
    async status(officeId) {
      const office = this.d.directory.office(officeId);
      const active = await this.d.store.findActive(office.id);
      const pos = await this.budget(office);
      const box = active ? this.describe(active) : "The snack box is not reported empty.";
      return `${box} Budget ${pos.month}: ${format(pos.spent)} spent, ${format(pos.reserved)} reserved, ${format(pos.remaining)} left of ${format(pos.budget)}.`;
    }
    async budget(office) {
      return budgetPosition(office, localMonth(this.d.clock.now(), office.timeZone), await this.d.store.list());
    }
    // ─── Scheduler ──────────────────────────────────────────────────────────────
    /**
     * Run every few minutes. Handles everything time-based: expired offers, reminders, lapsed
     * commitments, budget holds at the start of a month, HR retries and HR status polling.
     * A refill that changed underneath us is simply skipped; the next tick sees the new state.
     * One failing refill (e.g. HR timing out) never stops the others; failures are returned for logging.
     */
    async tick() {
      const failures = [];
      for (const refill of await this.d.store.list()) {
        try {
          await this.tickOne(refill);
        } catch (e) {
          if (e instanceof DomainError && e.code === "CONCURRENT_UPDATE") continue;
          failures.push({ refillId: refill.id, error: e });
        }
      }
      return failures;
    }
    async tickOne(refill) {
      const now = this.d.clock.now();
      const nudges = refill.status === "AWAITING_VOLUNTEER" || refill.status === "COMMITTED" || refill.status === "ON_HOLD_BUDGET";
      if (nudges && !this.inOfficeHours(now, this.d.directory.office(refill.officeId))) return;
      switch (refill.status) {
        case "AWAITING_VOLUNTEER": {
          if (refill.offer && now < refill.offer.expiresAt) return;
          const to = refill.offer?.to;
          if (to) {
            const next = await this.write(refill, { passedOver: [...refill.passedOver, to], offer: void 0 }, "OFFER_EXPIRED", to);
            await this.d.chat.sendDirect(to, `No worries, I've asked someone else to refill ${refill.id}.`);
            await this.findBuyer(next);
          } else {
            await this.findBuyer(refill);
          }
          return;
        }
        case "COMMITTED": {
          const c = refill.commitment;
          if (now >= c.dueAt) {
            const next = await this.write(
              refill,
              { status: "AWAITING_VOLUNTEER", commitment: void 0, lapsedBuyer: c.buyer, passedOver: [...refill.passedOver, c.buyer] },
              "COMMITMENT_LAPSED",
              c.buyer
            );
            await this.d.chat.sendDirect(
              c.buyer,
              `Refill ${refill.id} wasn't reported in time, so I'm handing it to someone else. If you already bought, report it now with "/snack bought ${refill.id} <amount> <receipt>".`
            );
            await this.findBuyer(next);
          } else if (!c.reminderSent && now.getTime() >= c.dueAt.getTime() - this.d.policy.reminderLeadMs) {
            await this.write(refill, { commitment: { ...c, reminderSent: true } }, "REMINDED", c.buyer);
            await this.d.chat.sendDirect(
              c.buyer,
              `Reminder: refill ${refill.id} is due by ${this.when(c.dueAt, this.d.directory.office(refill.officeId))}. Can't make it? "/snack release ${refill.id}" hands it on.`,
              [{ label: "Can't make it", command: `/snack release ${refill.id}` }]
            );
          }
          return;
        }
        case "ON_HOLD_BUDGET":
          await this.findBuyer(refill);
          return;
        case "PURCHASED":
          await this.submitClaim(refill);
          return;
        case "CLAIM_SUBMITTED":
          await this.pollClaim(refill);
          return;
        default:
          return;
      }
    }
    /** The committed buyer can't make it after all. */
    async release(refillId, employeeId) {
      const refill = await this.load(refillId);
      if (refill.status !== "COMMITTED" || refill.commitment.buyer !== employeeId) {
        throw new DomainError("NOT_ALLOWED", "You are not the committed buyer for this refill.");
      }
      const next = await this.write(
        refill,
        { status: "AWAITING_VOLUNTEER", commitment: void 0, passedOver: [...refill.passedOver, employeeId] },
        "RELEASED",
        employeeId
      );
      return this.findBuyer(next);
    }
    // ─── Internals ──────────────────────────────────────────────────────────────
    /** Checks the budget, then offers the refill to the best candidate, or to the whole channel. */
    async findBuyer(refill) {
      const office = this.d.directory.office(refill.officeId);
      const now = this.d.clock.now();
      const all = await this.d.store.list();
      const position = budgetPosition(office, localMonth(now, office.timeZone), all);
      const decision = decideSpendLimit(office, position);
      if (!decision.ok) {
        if (refill.status === "ON_HOLD_BUDGET") return refill;
        const next2 = await this.write(refill, { status: "ON_HOLD_BUDGET", offer: void 0 }, "BUDGET_HOLD", void 0, format(decision.remaining));
        const text = `The ${office.name} snack budget for ${position.month} is used up (${format(decision.remaining)} left). The refill resumes automatically next month.`;
        await this.d.chat.postToChannel(office.channel, text);
        await this.notifyAdmins(office, `${text} Refill ${refill.id} is on hold.`);
        return next2;
      }
      const ranked = rankCandidates({
        office,
        today: localDate(now, office.timeZone),
        now,
        volunteers: this.d.directory.listVolunteers(),
        presenceOn: (id, date) => this.d.directory.presenceOn(id, date),
        refills: all,
        exclude: new Set(refill.passedOver),
        policy: this.d.policy
      });
      const pick = ranked[0];
      if (pick && refill.directOffers < this.d.policy.maxDirectOffers) {
        const next2 = await this.write(
          refill,
          {
            status: "AWAITING_VOLUNTEER",
            directOffers: refill.directOffers + 1,
            offer: { to: pick.employeeId, sentAt: now, expiresAt: addMs(now, this.d.policy.offerTimeoutMs) }
          },
          "OFFERED",
          pick.employeeId
        );
        await this.d.chat.sendDirect(
          pick.employeeId,
          `The ${office.name} snack box is empty. Could you refill it today? Budget up to ${format(decision.spendLimit)}. You're being asked because you've done ${pick.recentRefills} refill(s) in the last 30 days.`,
          [
            { label: "Yes, I'll buy", command: `/snack yes ${refill.id}` },
            { label: "Can't today", command: `/snack no ${refill.id}` }
          ]
        );
        return next2;
      }
      const repeat = refill.offer?.to === null;
      const next = await this.write(
        refill,
        {
          status: "AWAITING_VOLUNTEER",
          escalated: refill.escalated || repeat,
          offer: { to: null, sentAt: now, expiresAt: addMs(now, this.d.policy.broadcastTimeoutMs) }
        },
        "BROADCAST"
      );
      await this.d.chat.postToChannel(
        office.channel,
        `${repeat ? "Still empty: " : ""}The ${office.name} snack box needs a refill and nobody has picked it up yet. Anyone in the office today? Budget up to ${format(decision.spendLimit)}.`,
        [{ label: "I'll do it", command: `/snack yes ${refill.id}` }]
      );
      if (repeat && !refill.escalated) {
        await this.notifyAdmins(office, `Nobody has picked up refill ${refill.id} since ${this.when(refill.reportedAt, office)}.`);
      }
      return next;
    }
    async submitClaim(refill) {
      if (this.claimsInFlight.has(refill.id)) return refill;
      this.claimsInFlight.add(refill.id);
      try {
        const office = this.d.directory.office(refill.officeId);
        const p = refill.purchase;
        const items = p.items.length ? `: ${p.items.join(", ")}` : "";
        let claimId;
        try {
          claimId = await this.d.hr.createClaim({
            employeeId: p.buyer,
            amount: toDecimalString(p.amount),
            currency: p.amount.currency,
            description: `Snack refill, ${office.name} office, ${p.budgetMonth} [${refill.id}]${items}`,
            receiptImage: p.receiptImage
          });
        } catch (e) {
          const next2 = await this.write(refill, { claimAttempts: refill.claimAttempts + 1 }, "CLAIM_SUBMIT_FAILED", void 0, String(e));
          if (next2.claimAttempts === this.d.policy.claimAttemptsBeforeEscalation) {
            await this.notifyAdmins(office, `Filing the HR claim for ${refill.id} has failed ${next2.claimAttempts} times. Still retrying.`);
          }
          return next2;
        }
        const next = await this.write(
          refill,
          { status: "CLAIM_SUBMITTED", claimAttempts: refill.claimAttempts + 1, claim: { claimId, submittedAt: this.d.clock.now() } },
          "CLAIM_SUBMITTED",
          void 0,
          claimId
        );
        await this.d.chat.sendDirect(
          p.buyer,
          `I've filed reimbursement claim ${claimId} for ${format(p.amount)}. HR usually approves within 1-10 days, and you'll be paid in your payroll currency. I'll tell you when it's approved.`
        );
        return next;
      } finally {
        this.claimsInFlight.delete(refill.id);
      }
    }
    async pollClaim(refill) {
      const claim = refill.claim;
      const status = await this.d.hr.getClaimStatus(claim.claimId);
      const buyer = refill.purchase.buyer;
      const office = this.d.directory.office(refill.officeId);
      if (status.state === "APPROVED") {
        await this.write(refill, { status: "REIMBURSED", claim: { ...claim, decidedAt: status.decidedAt } }, "REIMBURSED");
        await this.d.chat.sendDirect(buyer, `HR approved claim ${claim.claimId} for ${format(refill.purchase.amount)}. Thanks for refilling!`);
      } else if (status.state === "REJECTED") {
        await this.write(
          refill,
          { status: "CLAIM_REJECTED", claim: { ...claim, decidedAt: status.decidedAt, rejectionReason: status.reason } },
          "CLAIM_REJECTED",
          void 0,
          status.reason
        );
        await this.d.chat.sendDirect(buyer, `HR rejected claim ${claim.claimId}: ${status.reason}. An admin has been told and will follow up.`);
        await this.notifyAdmins(office, `HR rejected claim ${claim.claimId} (${refill.id}, ${this.name(buyer)}): ${status.reason}`);
      } else if (!claim.overdueEscalated && this.d.clock.now().getTime() - claim.submittedAt.getTime() > this.d.policy.claimOverdueMs) {
        await this.write(refill, { claim: { ...claim, overdueEscalated: true } }, "CLAIM_OVERDUE");
        await this.notifyAdmins(office, `Claim ${claim.claimId} (${refill.id}, ${this.name(buyer)}) has been pending for over 10 days. Please chase HR.`);
      }
    }
    async write(prev, patch, type, by, detail) {
      const event = { at: this.d.clock.now(), type, ...by && { by }, ...detail && { detail } };
      const next = { ...prev, ...patch, version: prev.version + 1, history: [...prev.history, event] };
      return this.d.store.save(next, prev.version);
    }
    async load(id) {
      const r = await this.d.store.get(id);
      if (!r) throw new DomainError("NOT_FOUND", `No refill ${id}`);
      return r;
    }
    requireAdmin(refill, adminId) {
      if (!this.d.directory.office(refill.officeId).admins.includes(adminId)) {
        throw new DomainError("NOT_ALLOWED", "Only an office admin can do that.");
      }
    }
    async notifyAdmins(office, text, actions) {
      for (const admin of office.admins) await this.d.chat.sendDirect(admin, text, actions);
    }
    describe(r) {
      switch (r.status) {
        case "COMMITTED":
          return `${this.name(r.commitment.buyer)} is already refilling the snack box (${r.id}).`;
        case "ON_HOLD_BUDGET":
          return `The snack box is empty but this month's budget is used up (${r.id}).`;
        default:
          return r.offer?.to ? `The snack box is already reported empty and ${this.name(r.offer.to)} has been asked to refill it (${r.id}).` : `The snack box is already reported empty and we're looking for a buyer (${r.id}).`;
      }
    }
    inOfficeHours(instant, office) {
      const { start, end, days } = this.d.policy.officeHours;
      const hour = localHour(instant, office.timeZone);
      return days.includes(weekdayOf(localDate(instant, office.timeZone))) && hour >= start && hour < end;
    }
    when(instant, office) {
      return `${formatLocal(instant, office.timeZone)} ${office.name} time`;
    }
    name(id) {
      return this.d.directory.volunteer(id)?.name ?? id;
    }
  };
  function normaliseItems(items) {
    return [...new Set(items.map((i) => i.trim().toLowerCase()).filter(Boolean))];
  }

  // src/core/report.ts
  function buildMonthlyReport(month, offices, refills, rates, reportingCurrency) {
    const officeReports = offices.map((office) => officeReport(month, office, refills, rates, reportingCurrency));
    const totalOf = (pick) => sum(
      officeReports.map((o) => convert(pick(o), reportingCurrency, o.rate)),
      reportingCurrency
    );
    const budget = sum(officeReports.map((o) => o.budgetConverted), reportingCurrency);
    const spent = sum(officeReports.map((o) => o.spentConverted), reportingCurrency);
    return {
      month,
      reportingCurrency,
      offices: officeReports,
      total: {
        budget,
        spent,
        reimbursed: totalOf((o) => o.reimbursed),
        awaitingReimbursement: totalOf((o) => o.awaitingReimbursement),
        utilisationPct: pct(spent, budget)
      }
    };
  }
  function officeReport(month, office, all, rates, to) {
    const refills = all.filter((r) => r.officeId === office.id && r.purchase?.budgetMonth === month);
    const amounts = (statuses) => sum(
      refills.filter((r) => statuses.includes(r.status)).map((r) => r.purchase.amount),
      office.currency
    );
    const reimbursed = amounts(["REIMBURSED"]);
    const awaitingReimbursement = amounts(["NEEDS_APPROVAL", "PURCHASED", "CLAIM_SUBMITTED"]);
    const rejected = amounts(["CLAIM_REJECTED"]);
    const spent = add(reimbursed, awaitingReimbursement);
    const counted = refills.filter((r) => r.status !== "CLAIM_REJECTED");
    const itemCounts = /* @__PURE__ */ new Map();
    const byVolunteer = {};
    for (const r of counted) {
      for (const item of r.purchase.items) itemCounts.set(item, (itemCounts.get(item) ?? 0) + 1);
      byVolunteer[r.purchase.buyer] = (byVolunteer[r.purchase.buyer] ?? 0) + 1;
    }
    const topItems = [...itemCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([item, n]) => ({ item, refills: n }));
    const downtimes = counted.map((r) => hoursBetween(r.reportedAt, r.purchase.purchasedAt));
    const rate = rates.rate(office.currency, to, month);
    return {
      officeId: office.id,
      office: office.name,
      currency: office.currency,
      budget: office.monthlyBudget,
      spent,
      reimbursed,
      awaitingReimbursement,
      rejected,
      remaining: subtract(office.monthlyBudget, spent),
      utilisationPct: pct(spent, office.monthlyBudget),
      refills: counted.length,
      avgHoursEmpty: downtimes.length ? round1(downtimes.reduce((a, b) => a + b, 0) / downtimes.length) : null,
      topItems,
      refillsByVolunteer: byVolunteer,
      rate,
      spentConverted: convert(spent, to, rate),
      budgetConverted: convert(office.monthlyBudget, to, rate)
    };
  }
  function renderReport(r) {
    const lines = [`Snack spending report for ${r.month} (totals in ${r.reportingCurrency})`, ""];
    for (const o of r.offices) {
      lines.push(
        `${o.office}: ${format(o.spent)} of ${format(o.budget)} (${o.utilisationPct}%), ${o.refills} refill(s)` + (o.currency !== r.reportingCurrency ? ` = ${format(o.spentConverted)} at ${o.rate}` : ""),
        `  reimbursed ${format(o.reimbursed)}, awaiting ${format(o.awaitingReimbursement)}, rejected ${format(o.rejected)}`,
        `  box empty on average ${o.avgHoursEmpty ?? "-"} h before refill; top items: ${o.topItems.map((t) => t.item).join(", ") || "-"}`
      );
    }
    lines.push("", `Total: ${format(r.total.spent)} of ${format(r.total.budget)} (${r.total.utilisationPct}%)`);
    return lines.join("\n");
  }
  function pct(part, whole) {
    if (whole.minor === 0) return 0;
    return round1(part.minor / whole.minor * 100);
  }
  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  // src/fakes/fake-chat.ts
  var FakeChat = class {
    constructor() {
      __publicField(this, "messages", []);
      __publicField(this, "listener");
    }
    onMessage(listener) {
      this.listener = listener;
    }
    async sendDirect(to, text, actions = []) {
      this.record({ kind: "direct", to, text, actions });
    }
    async postToChannel(channel, text, actions = []) {
      this.record({ kind: "channel", to: channel, text, actions });
    }
    directTo(employeeId) {
      return this.messages.filter((m) => m.kind === "direct" && m.to === employeeId);
    }
    inChannel(channel) {
      return this.messages.filter((m) => m.kind === "channel" && m.to === channel);
    }
    clear() {
      this.messages.length = 0;
    }
    record(m) {
      this.messages.push(m);
      this.listener?.(m);
    }
  };

  // src/fakes/fake-hr.ts
  var FakeHr = class {
    constructor(clock) {
      __publicField(this, "clock", clock);
      __publicField(this, "claims", /* @__PURE__ */ new Map());
      __publicField(this, "seq", 0);
      __publicField(this, "failuresRemaining", 0);
      __publicField(this, "statusFailuresRemaining", 0);
    }
    /** The next `n` createClaim calls throw, like an outage. */
    failNext(n) {
      this.failuresRemaining = n;
    }
    async createClaim(request) {
      if (this.failuresRemaining > 0) {
        this.failuresRemaining--;
        throw new Error("HR system unavailable (simulated)");
      }
      if (!/^\d+\.\d{2}$/.test(request.amount) || Number(request.amount) <= 0) {
        throw new Error(`HR rejected malformed amount "${request.amount}"`);
      }
      if (!request.employeeId || !request.receiptImage || !request.description) {
        throw new Error("HR rejected claim with missing fields");
      }
      const id = `HR-${++this.seq}`;
      this.claims.set(id, { id, request, createdAt: this.clock.now(), status: { state: "PENDING" } });
      return id;
    }
    /** The next `n` getClaimStatus calls throw. */
    failStatusNext(n) {
      this.statusFailuresRemaining = n;
    }
    async getClaimStatus(claimId) {
      if (this.statusFailuresRemaining > 0) {
        this.statusFailuresRemaining--;
        throw new Error("HR status endpoint timed out (simulated)");
      }
      const c = this.claims.get(claimId);
      if (!c) throw new Error(`Unknown claim ${claimId}`);
      return c.status;
    }
    approve(claimId) {
      this.decide(claimId, { state: "APPROVED", decidedAt: this.clock.now() });
    }
    reject(claimId, reason) {
      this.decide(claimId, { state: "REJECTED", decidedAt: this.clock.now(), reason });
    }
    /** Approves every pending claim older than `ageMs`. Used by the demo to mimic HR's 1-10 day turnaround. */
    approveOlderThan(ageMs) {
      const now = this.clock.now().getTime();
      for (const c of this.claims.values()) {
        if (c.status.state === "PENDING" && now - c.createdAt.getTime() >= ageMs) this.approve(c.id);
      }
    }
    decide(claimId, status) {
      const c = this.claims.get(claimId);
      if (!c) throw new Error(`Unknown claim ${claimId}`);
      if (c.status.state !== "PENDING") throw new Error(`Claim ${claimId} already decided`);
      c.status = status;
    }
  };

  // src/fakes/support.ts
  var FakeClock = class {
    constructor(start) {
      __publicField(this, "current");
      this.current = new Date(start);
    }
    now() {
      return new Date(this.current);
    }
    advance(ms) {
      this.current = new Date(this.current.getTime() + ms);
    }
    set(instant) {
      this.current = new Date(instant);
    }
  };
  var FixedRates = class {
    constructor(table, byMonth = {}) {
      __publicField(this, "table", table);
      __publicField(this, "byMonth", byMonth);
    }
    rate(from, to, month) {
      if (from === to) return 1;
      const k = `${from}->${to}`;
      const r = this.byMonth[month]?.[k] ?? this.table[k];
      if (r !== void 0) return r;
      const inverse = this.byMonth[month]?.[`${to}->${from}`] ?? this.table[`${to}->${from}`];
      if (inverse !== void 0) return 1 / inverse;
      throw new Error(`No exchange rate ${k} for ${month}`);
    }
  };
  var SequentialIds = class {
    constructor() {
      __publicField(this, "counters", /* @__PURE__ */ new Map());
    }
    next(prefix) {
      const n = (this.counters.get(prefix) ?? 0) + 1;
      this.counters.set(prefix, n);
      return `${prefix}-${n}`;
    }
  };

  // src/store/directory.ts
  var Directory = class {
    constructor(offices, volunteers = []) {
      __publicField(this, "offices", /* @__PURE__ */ new Map());
      __publicField(this, "volunteers", /* @__PURE__ */ new Map());
      __publicField(this, "presence", /* @__PURE__ */ new Map());
      __publicField(this, "officeDays", /* @__PURE__ */ new Map());
      for (const o of offices) this.offices.set(o.id, o);
      for (const v of volunteers) this.upsertVolunteer(v);
    }
    office(id) {
      const o = this.offices.get(id);
      if (!o) throw new DomainError("NOT_FOUND", `Unknown office ${id}`);
      return o;
    }
    listOffices() {
      return [...this.offices.values()];
    }
    upsertVolunteer(v) {
      this.office(v.homeOfficeId);
      this.volunteers.set(v.employeeId, v);
    }
    volunteer(id) {
      return this.volunteers.get(id);
    }
    requireVolunteer(id) {
      const v = this.volunteers.get(id);
      if (!v || !v.active) throw new DomainError("NOT_ALLOWED", `${id} is not an active snack volunteer`);
      return v;
    }
    listVolunteers() {
      return [...this.volunteers.values()];
    }
    setPresence(employeeId, date, status) {
      if (status.kind === "office") this.office(status.officeId);
      this.presence.set(key(employeeId, date), status);
    }
    /** One command for a whole trip or holiday instead of one per day. */
    setPresenceRange(employeeId, from, to, status) {
      const days = datesBetween(from, to);
      for (const d of days) this.setPresence(employeeId, d, status);
      return days;
    }
    clearPresence(employeeId, date) {
      this.presence.delete(key(employeeId, date));
    }
    /**
     * The volunteer's usual home-office days, e.g. [1, 3, 4] for Mon/Wed/Thu. On other days they count
     * as remote. `null` removes the pattern (back to "unknown" when they haven't said anything).
     */
    setOfficeDays(employeeId, days) {
      if (days === null) this.officeDays.delete(employeeId);
      else this.officeDays.set(employeeId, new Set(days));
    }
    usualOfficeDays(employeeId) {
      const days = this.officeDays.get(employeeId);
      return days ? [...days].sort() : void 0;
    }
    /**
     * Where someone is on a date. Most specific wins: an entry for that day (check-in, trip, holiday),
     * then their usual weekly pattern. undefined means they haven't told us anything.
     */
    presenceOn(employeeId, date) {
      const explicit = this.presence.get(key(employeeId, date));
      if (explicit) return explicit;
      const pattern = this.officeDays.get(employeeId);
      const v = this.volunteers.get(employeeId);
      if (!pattern || !v) return void 0;
      return pattern.has(weekdayOf(date)) ? { kind: "office", officeId: v.homeOfficeId } : { kind: "remote" };
    }
  };
  function key(employeeId, date) {
    return `${employeeId}|${date}`;
  }

  // src/store/refill-store.ts
  var InMemoryRefillStore = class {
    constructor() {
      __publicField(this, "rows", /* @__PURE__ */ new Map());
    }
    async get(id) {
      await tick();
      return this.rows.get(id);
    }
    async list() {
      await tick();
      return [...this.rows.values()];
    }
    async findActive(officeId) {
      await tick();
      return this.findActiveSync(officeId);
    }
    async insertIfNoActive(refill) {
      await tick();
      const existing = this.findActiveSync(refill.officeId);
      if (existing) return { inserted: false, existing };
      if (this.rows.has(refill.id)) throw new Error(`Duplicate refill id ${refill.id}`);
      this.rows.set(refill.id, refill);
      return { inserted: true, refill };
    }
    async save(next, expectedVersion) {
      await tick();
      const current2 = this.rows.get(next.id);
      if (!current2) throw new DomainError("NOT_FOUND", `Refill ${next.id} not found`);
      if (current2.version !== expectedVersion) {
        throw new DomainError("CONCURRENT_UPDATE", `Refill ${next.id} was changed by someone else`);
      }
      if (next.version !== expectedVersion + 1) throw new Error("Version must be incremented by exactly one");
      if (ACTIVE_STATUSES.has(next.status)) {
        const other = this.findActiveSync(next.officeId);
        if (other && other.id !== next.id) throw new DomainError("INVALID_STATE", `Office ${next.officeId} already has an active refill`);
      }
      this.rows.set(next.id, next);
      return next;
    }
    findActiveSync(officeId) {
      for (const r of this.rows.values()) {
        if (r.officeId === officeId && ACTIVE_STATUSES.has(r.status)) return r;
      }
      return void 0;
    }
  };
  function tick() {
    return new Promise((resolve) => typeof setImmediate === "function" ? setImmediate(resolve) : queueMicrotask(resolve));
  }

  // src/app.ts
  function createSnackApp(options = {}) {
    const clock = new FakeClock(options.start ?? "2026-11-02T08:00:00Z");
    const chat = new FakeChat();
    const hr = new FakeHr(clock);
    const store = new InMemoryRefillStore();
    const directory = new Directory(options.offices ?? OFFICES, options.volunteers ?? []);
    const policy = { ...DEFAULT_POLICY, ...options.policy };
    const rates = options.rates ?? new FixedRates({ "INR->NOK": 0.13 });
    const reportingCurrency = options.reportingCurrency ?? "NOK";
    const managementChannel = options.managementChannel ?? "#snack-reports";
    const service = new RefillService({ store, directory, chat, hr, clock, ids: new SequentialIds(), policy });
    const commands = new ChatCommands(service, directory, clock);
    async function monthlyReport(month) {
      return buildMonthlyReport(month, directory.listOffices(), await store.list(), rates, reportingCurrency);
    }
    async function sendMonthlyReport(month) {
      const report2 = await monthlyReport(month);
      await chat.postToChannel(managementChannel, renderReport(report2));
      return report2;
    }
    return { clock, chat, hr, store, directory, policy, service, commands, monthlyReport, sendMonthlyReport };
  }

  // web/main.ts
  var START = "2026-11-02T08:00:00Z";
  var OSLO = "Europe/Oslo";
  var VOLUNTEERS = [
    ...["Ada", "Bj\xF8rn", "Camilla", "Dag", "Eirin", "Fredrik"].map((name, i) => ({ employeeId: `osl-${i + 1}`, name, homeOfficeId: "OSL", active: true })),
    ...["Anil", "Bhavna", "Chetan", "Divya", "Esha", "Farhan", "Gauri"].map((name, i) => ({ employeeId: `blr-${i + 1}`, name, homeOfficeId: "BLR", active: true }))
  ];
  var ADMINS = { "osl-admin": "Oslo office manager", "blr-admin": "Bengaluru office manager" };
  var PATTERNS = [
    ["osl-1", [1, 2, 4]],
    ["osl-2", [1, 3]],
    ["osl-3", [2, 3, 4]],
    ["osl-5", [1, 2, 3, 4, 5]],
    ["osl-6", [3, 5]],
    ["blr-1", [1, 2, 3, 4, 5]],
    ["blr-2", [1, 3, 5]],
    ["blr-3", [2, 4]],
    ["blr-5", [1, 2, 3, 4]],
    ["blr-7", [1, 2]]
  ];
  var Sim = class {
    constructor() {
      __publicField(this, "app", createSnackApp({ start: START, volunteers: VOLUNTEERS }));
      __publicField(this, "entries", []);
      /** How long the simulated HR takes to approve a given claim (the brief says 1–10 days). */
      __publicField(this, "hrApprovalMs", () => 3 * DAY);
      __publicField(this, "muted", false);
      this.app.chat.onMessage((msg) => {
        if (!this.muted) this.entries.push({ kind: "bot", at: this.app.clock.now(), msg });
      });
      for (const [id, days] of PATTERNS) this.app.directory.setOfficeDays(id, days);
      this.app.directory.setPresenceRange("osl-5", "2026-11-02", "2026-11-06", { kind: "holiday" });
    }
    /** Runs setup steps without adding them to the transcript. */
    async quietly(fn) {
      this.muted = true;
      try {
        await fn();
      } finally {
        this.muted = false;
      }
    }
    async say(who, text) {
      const entry2 = { kind: "user", at: this.app.clock.now(), who, text };
      if (!this.muted) this.entries.push(entry2);
      entry2.reply = await this.app.commands.handle(who, text);
      return entry2.reply;
    }
    note(text) {
      this.entries.push({ kind: "note", at: this.app.clock.now(), text });
    }
    /** Moves time forward in 15-minute steps, running the scheduler each step like a cron job. */
    async advance(ms) {
      const end = this.app.clock.now().getTime() + ms;
      while (this.app.clock.now().getTime() < end) {
        this.app.clock.advance(Math.min(15 * MINUTE, end - this.app.clock.now().getTime()));
        const now = this.app.clock.now().getTime();
        for (const c of this.app.hr.claims.values()) {
          if (c.status.state === "PENDING" && now - c.createdAt.getTime() >= this.hrApprovalMs(c.id)) this.app.hr.approve(c.id);
        }
        await this.app.service.tick();
      }
    }
    async advanceTo(iso) {
      await this.advance(new Date(iso).getTime() - this.app.clock.now().getTime());
    }
    async active(officeId) {
      return this.app.store.findActive(officeId);
    }
  };
  var SCENARIOS = {
    race: {
      title: "Two people tap \u201CYes\u201D at once",
      summary: "Ada and Bj\xF8rn both offer to buy within the same millisecond.",
      proves: "Only one buyer per refill",
      async run(s) {
        s.note("Dag finds the Oslo box empty. Ada and Bj\xF8rn both tap \u201CYes\u201D within milliseconds.");
        await s.say("osl-4", "/snack empty");
        const r = await s.active("OSL");
        await Promise.all([s.say("osl-1", `/snack yes ${r.id}`), s.say("osl-2", `/snack yes ${r.id}`)]);
        s.note("Exactly one commit wins (a compare-and-set on the refill\u2019s version). The other person is told not to buy.");
      }
    },
    silence: {
      title: "Nobody answers",
      summary: "The box is reported empty and every DM goes unanswered.",
      proves: "A stalled refill escalates",
      async run(s) {
        s.note("The box is reported empty, and nobody answers their DM.");
        await s.say("osl-4", "/snack empty");
        for (let i = 0; i < 3; i++) await s.advance(2 * HOUR);
        s.note("After three unanswered 2-hour offers, the refill is opened to the whole #snacks-oslo channel.");
        await s.advanceTo("2026-11-03T07:15:00Z");
        s.note("Still nobody. The bot stays quiet overnight; at 08:00 the next morning it posts again and alerts the office manager.");
      }
    },
    lapse: {
      title: "Buyer commits, then forgets",
      summary: "Someone says \u201CYes\u201D, then never reports a purchase.",
      proves: "Unfinished refills are handed on",
      async run(s) {
        await s.say("osl-4", "/snack empty");
        const r = await s.active("OSL");
        await s.say(r.offer.to, `/snack yes ${r.id}`);
        s.note("The buyer has 24 hours. The reminder is due 6 hours before the deadline, at 03:00, so it waits for office hours\u2026");
        await s.advance(23 * HOUR + 15 * MINUTE);
        s.note("\u2026and goes out at 08:00 instead. The deadline at 09:00 passes without a purchase.");
        await s.advance(45 * MINUTE);
        s.note("The refill is handed to the next person and the budget reservation is released. The first buyer can still report a late purchase until someone else commits.");
      }
    },
    visitor: {
      title: "Visiting the other office",
      summary: "Anil from Bengaluru works from Oslo for two weeks.",
      proves: "People are asked where they are",
      async run(s) {
        s.note("Anil will be in Oslo for two weeks. One command covers the whole trip, with no daily check-ins.");
        await s.say("blr-1", "/snack visiting oslo 2026-11-02 2026-11-13");
        await s.say("osl-4", "/snack empty");
        await s.say("blr-3", "/snack empty");
        s.note("Anil is asked in Oslo, where he is, and skipped in Bengaluru even though he is usually in on weekdays. A purchase in Oslo is charged to Oslo\u2019s NOK budget; HR pays him in INR.");
      }
    },
    budget: {
      title: "The budget runs out",
      summary: "Five big refills use up most of Oslo\u2019s 6,000 NOK.",
      proves: "Spending stays within budget",
      async run(s) {
        await s.quietly(async () => {
          for (const b of ["osl-1", "osl-2", "osl-3", "osl-4", "osl-6"]) {
            await s.say("osl-4", "/snack empty");
            const r = await s.active("OSL");
            await s.say(b, `/snack yes ${r.id}`);
            await s.say(b, `/snack bought ${r.id} 1150 https://receipts/${r.id}.jpg chips, fruit`);
            await s.advance(HOUR);
          }
        });
        s.note("Earlier today, five refills of 1,150 NOK used 5,750 of Oslo\u2019s 6,000 NOK monthly budget. Now the box is empty again.");
        await s.say("osl-4", "/snack status");
        await s.say("osl-4", "/snack empty");
        s.note("Only 250 NOK is left, below a sensible minimum purchase of 300 NOK, so the refill is put on hold and the manager is told. Fast-forward to December\u2026");
        await s.quietly(() => s.advanceTo("2026-12-01T06:45:00Z"));
        await s.advanceTo("2026-12-01T07:15:00Z");
        s.note("The December budget starts at midnight in Oslo. The bot waits for office hours, then resumes the refill by itself.");
      }
    },
    overLimit: {
      title: "A receipt above the limit",
      summary: "A buyer spends 1,480 NOK against a 1,200 NOK limit.",
      proves: "Big receipts need a manager",
      async run(s) {
        await s.say("osl-4", "/snack empty");
        const r = await s.active("OSL");
        const buyer = r.offer.to;
        await s.say(buyer, `/snack yes ${r.id}`);
        await s.say(buyer, `/snack bought ${r.id} 1480 https://receipts/${r.id}.jpg cake, coffee`);
        s.note("1,480 NOK is above the pre-approved limit, so the HR claim waits for the office manager.");
        await s.advance(30 * MINUTE);
        await s.say("osl-admin", `/snack approve ${r.id}`);
        s.note("Approved: the claim goes to HR, and the 1,480 NOK counts against this month\u2019s budget.");
      }
    },
    month: {
      title: "A whole month, both offices",
      summary: "Every working day of November with random empties, declines and timeouts.",
      proves: "One report in two currencies",
      async run(s) {
        s.note("Simulating November at both offices: boxes empty at random, some people decline or don\u2019t answer, and HR takes 1 to 10 days to approve each claim.");
        await simulateMonth(s);
        s.note("Done. The management report below is the result of this month.");
      }
    }
  };
  function rng(seed) {
    return () => {
      seed = seed + 1831565813 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  async function simulateMonth(s) {
    const rand = rng(7);
    s.hrApprovalMs = (id) => (1 + Number(id.replace(/\D/g, "")) * 37 % 10) * DAY;
    const items = {
      OSL: ["chips", "fruit", "kvikk lunsj", "nuts", "cola", "knekkebr\xF8d"],
      BLR: ["samosa", "biscuits", "banana chips", "chikki", "juice", "fruit"]
    };
    for (let day = 2; day <= 30; day++) {
      const date = `2026-11-${String(day).padStart(2, "0")}`;
      await s.advanceTo(`${date}T07:30:00Z`);
      const weekday = (/* @__PURE__ */ new Date(`${date}T12:00:00Z`)).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      for (const office of s.app.directory.listOffices()) {
        if (rand() > 0.34 || await s.active(office.id)) continue;
        const locals = VOLUNTEERS.filter((v) => v.homeOfficeId === office.id);
        const pick = () => locals[Math.floor(rand() * locals.length)].employeeId;
        await s.say(pick(), `/snack empty ${office.id}`);
        for (let attempt = 0; attempt < 6; attempt++) {
          const r2 = await s.active(office.id);
          if (!r2 || r2.status !== "AWAITING_VOLUNTEER") break;
          const who = r2.offer?.to ?? pick();
          const roll = rand();
          if (roll < 0.65) {
            await s.say(who, `/snack yes ${r2.id}`);
            break;
          }
          if (roll < 0.85) await s.say(who, `/snack no ${r2.id}`);
          else await s.advance(2 * HOUR);
        }
        const r = await s.active(office.id);
        if (r?.status !== "COMMITTED") continue;
        const [lo, hi] = office.currency === "NOK" ? [350, 1150] : [600, 2900];
        const amount = Math.min(Math.round((lo + rand() * (hi - lo)) / 10) * 10, Math.floor(r.commitment.spendLimit.minor / 100));
        const bought = items[office.id].filter(() => rand() < 0.4).join(", ") || items[office.id][0];
        await s.advance(HOUR);
        await s.say(r.commitment.buyer, `/snack bought ${r.id} ${amount} https://receipts/${r.id}.jpg ${bought}`);
      }
    }
    await s.advanceTo("2026-11-30T17:00:00Z");
  }
  function h(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function personName(id) {
    return VOLUNTEERS.find((v) => v.employeeId === id)?.name ?? ADMINS[id] ?? id;
  }
  function avatar(id) {
    if (id === "bot") return `<span class="avatar bot" aria-hidden="true">S</span>`;
    const cls = id.startsWith("osl") ? "osl" : id.startsWith("blr") ? "blr" : "admin";
    return `<span class="avatar ${cls}" aria-hidden="true">${h(personName(id).charAt(0))}</span>`;
  }
  var timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: OSLO, hour: "2-digit", minute: "2-digit", hour12: false });
  var dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: OSLO, weekday: "long", day: "numeric", month: "long" });
  function richText(text) {
    return h(text).replace(/\b(R-(?:OSL|BLR)-\d+|HR-\d+)\b/g, '<span class="ref">$1</span>').replace(/(\d[\d,]*\.\d{2} (?:NOK|INR))/g, '<b class="amt">$1</b>');
  }
  function transcript(entries) {
    let lastDay = "";
    let i = 0;
    const rows = [];
    for (const e of entries) {
      const day = localDate(e.at, OSLO);
      if (day !== lastDay) {
        rows.push(`<div class="day" style="--i:${i++}"><span>${h(dayFmt.format(e.at))}</span></div>`);
        lastDay = day;
      }
      rows.push(entry(e, i++));
    }
    return rows.join("");
  }
  function entry(e, i) {
    const time = `<time>${h(timeFmt.format(e.at))}</time>`;
    const style = `style="--i:${Math.min(i, 60)}"`;
    if (e.kind === "note") {
      return `<div class="note" ${style}><span class="note-mark" aria-hidden="true"></span><p>${h(e.text)}</p></div>`;
    }
    if (e.kind === "user") {
      return `<div class="msg" ${style}>${avatar(e.who)}<div class="body">
      <div class="meta"><b>${h(personName(e.who))}</b>${time}</div>
      <code class="cmd">${h(e.text)}</code>
      ${e.reply ? `<div class="reply">${richText(e.reply.split("\n")[0])}</div>` : ""}
    </div></div>`;
    }
    const m = e.msg;
    const where = m.kind === "channel" ? `<span class="where channel">${h(m.to)}</span>` : `<span class="where dm">DM to ${h(personName(m.to))}</span>`;
    const buttons = m.actions.filter((a) => !a.command.includes("<"));
    return `<div class="msg bot ${m.kind}" ${style}>${avatar("bot")}<div class="body">
    <div class="meta"><b>Snack bot</b>${where}${time}</div>
    <div class="text">${richText(m.text)}</div>
    ${buttons.length ? `<div class="buttons">${buttons.map((a) => `<span class="fake-btn">${h(a.label)}</span>`).join("")}</div>` : ""}
  </div></div>`;
  }
  async function monthSummary(s) {
    const refills = await s.app.store.list();
    const events = refills.flatMap((r) => r.history.map((e) => e.type));
    const count = (t) => events.filter((e) => e === t).length;
    const tiles = [
      ["Refills bought", refills.filter((r) => r.purchase).length],
      ["Direct offers sent", count("OFFERED")],
      ["Declined", count("DECLINED")],
      ["Unanswered, passed on", count("OFFER_EXPIRED")],
      ["HR claims filed", s.app.hr.claims.size],
      ["Chat messages", s.entries.filter((e) => e.kind === "bot").length]
    ];
    const tail = s.entries.filter((e) => e.kind !== "note").slice(-8);
    return `
    <div class="tiles">${tiles.map(([label, n]) => `<div class="tile"><b>${n}</b><span>${h(label)}</span></div>`).join("")}</div>
    <p class="tail-label">The last few messages of the month</p>
    ${transcript(tail)}
    <a class="to-report" href="#report">See the management report \u2193</a>`;
  }
  function pct2(part, whole) {
    return whole.minor ? Math.min(100, part.minor / whole.minor * 100) : 0;
  }
  function officeBlock(o, reporting) {
    const reimbursedPct = pct2(o.reimbursed, o.budget);
    const awaitingPct = pct2(o.awaitingReimbursement, o.budget);
    const buyers = Object.entries(o.refillsByVolunteer).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return `
  <div class="office">
    <div class="office-top">
      <div><h3>${h(o.office)}</h3><span class="muted">${h(o.currency)} budget</span></div>
      <div class="office-figure"><b>${h(format(o.spent))}</b><span>of ${h(format(o.budget))} \xB7 ${o.utilisationPct}%</span></div>
    </div>
    <div class="bar" role="img" aria-label="${o.utilisationPct}% of budget used">
      <span class="reimbursed" style="width:${reimbursedPct}%"></span><span class="awaiting" style="width:${awaitingPct}%"></span>
    </div>
    <dl class="facts">
      <div><dt>Reimbursed</dt><dd>${h(format(o.reimbursed))}</dd></div>
      <div><dt>Awaiting HR</dt><dd>${h(format(o.awaitingReimbursement))}</dd></div>
      <div><dt>Refills</dt><dd>${o.refills}</dd></div>
      <div><dt>Box empty, avg</dt><dd>${o.avgHoursEmpty ?? "-"} h</dd></div>
      ${o.currency !== reporting ? `<div><dt>In ${h(reporting)}</dt><dd>${h(format(o.spentConverted))}</dd></div>` : ""}
    </dl>
    <div class="lists">
      <div><h4>Most bought</h4><ol class="items">${o.topItems.slice(0, 4).map((t) => `<li>${h(t.item)} <span>${t.refills}\xD7</span></li>`).join("")}</ol></div>
      <div><h4>Refills per volunteer</h4><ul class="buyers">${buyers.map(([id, n]) => `<li>${avatar(id)}${h(personName(id))} <span>${n}</span></li>`).join("")}</ul></div>
    </div>
  </div>`;
  }
  function reportCard(r) {
    const monthName = (/* @__PURE__ */ new Date(`${r.month}-15T12:00:00Z`)).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    const refills = r.offices.reduce((n, o) => n + o.refills, 0);
    return `
  <header class="report-head">
    <div>
      <span class="eyebrow">Posted to #snack-reports on 1 December</span>
      <h2>Snack spending, ${h(monthName)}</h2>
    </div>
    <span class="sample">Sample data</span>
  </header>
  <div class="kpis">
    <div class="kpi main"><span>Total spent, both offices</span><b>${h(format(r.total.spent))}</b><em>${r.total.utilisationPct}% of ${h(format(r.total.budget))}</em></div>
    <div class="kpi"><span>Reimbursed</span><b>${h(format(r.total.reimbursed))}</b></div>
    <div class="kpi"><span>Awaiting HR</span><b>${h(format(r.total.awaitingReimbursement))}</b></div>
    <div class="kpi"><span>Refills</span><b>${refills}</b></div>
  </div>
  <div class="offices">${r.offices.map((o) => officeBlock(o, r.reportingCurrency)).join("")}</div>
  <p class="footnote">Each office is totalled exactly in its own currency; only the totals are converted, at the month\u2019s rate
    (1 INR = ${r.offices.find((o) => o.currency === "INR")?.rate ?? "-"} NOK). \u201CBox empty\u201D is the average time from \u201Creported empty\u201D to \u201Cbought\u201D.
    Generated by simulating November with the same code as the scenarios above.</p>`;
  }
  var list = document.getElementById("scenario-list");
  var stage = document.getElementById("stage");
  var report = document.getElementById("report");
  var current = "";
  var runId = 0;
  function renderList() {
    list.innerHTML = Object.entries(SCENARIOS).map(
      ([key2, s], i) => `
      <li><button class="scenario ${key2 === current ? "on" : ""}" data-key="${key2}" aria-pressed="${key2 === current}">
        <span class="num">${i + 1}</span>
        <span class="scenario-text"><b>${h(s.title)}</b><span>${h(s.summary)}</span><em>${h(s.proves)}</em></span>
      </button></li>`
    ).join("");
  }
  async function play(key2) {
    const scenario = SCENARIOS[key2];
    if (!scenario) return;
    current = key2;
    const id = ++runId;
    renderList();
    history.replaceState(null, "", `#scenario=${key2}`);
    stage.innerHTML = `<div class="stage-head"><div><span class="eyebrow">Scenario ${Object.keys(SCENARIOS).indexOf(key2) + 1} of 7</span><h2>${h(scenario.title)}</h2></div></div><div class="loading">Running\u2026</div>`;
    const sim = new Sim();
    await scenario.run(sim);
    if (id !== runId) return;
    const body = key2 === "month" ? await monthSummary(sim) : transcript(sim.entries);
    stage.innerHTML = `
    <div class="stage-head">
      <div><span class="eyebrow">Scenario ${Object.keys(SCENARIOS).indexOf(key2) + 1} of 7 \xB7 times in Oslo</span><h2>${h(scenario.title)}</h2></div>
      <button class="replay" data-replay="${key2}">Replay</button>
    </div>
    <div class="proves">Proves: <b>${h(scenario.proves)}</b></div>
    <div class="chat">${body}</div>`;
  }
  list.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-key]");
    if (btn) void play(btn.dataset.key);
  });
  stage.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-replay]");
    if (btn) void play(btn.dataset.replay);
  });
  async function buildReport() {
    const sim = new Sim();
    await simulateMonth(sim);
    report.innerHTML = reportCard(await sim.app.monthlyReport("2026-11"));
  }
  var fromHash = /^#scenario=(\w+)$/.exec(location.hash)?.[1];
  void play(fromHash && SCENARIOS[fromHash] ? fromHash : "race");
  void buildReport();
})();
