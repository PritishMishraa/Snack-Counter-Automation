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
    claimAttemptsBeforeEscalation: 3
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
    const busy2 = new Set(
      input.refills.filter((r) => r.status === "COMMITTED" && r.commitment).map((r) => r.commitment.buyer)
    );
    const candidates = [];
    for (const v of input.volunteers) {
      if (!v.active || input.exclude.has(v.employeeId) || busy2.has(v.employeeId)) continue;
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
      const active2 = await this.d.store.findActive(office.id);
      const pos = await this.budget(office);
      const box = active2 ? this.describe(active2) : "The snack box is not reported empty.";
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
      const current = this.rows.get(next.id);
      if (!current) throw new DomainError("NOT_FOUND", `Refill ${next.id} not found`);
      if (current.version !== expectedVersion) {
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
      const report = await monthlyReport(month);
      await chat.postToChannel(managementChannel, renderReport(report));
      return report;
    }
    return { clock, chat, hr, store, directory, policy, service, commands, monthlyReport, sendMonthlyReport };
  }

  // web/main.ts
  var START = "2026-11-02T08:00:00Z";
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
  var app;
  var feed = [];
  var feedFilter = "all";
  var hrAutoApprove = true;
  var actingAs = "osl-4";
  var busy = false;
  var scenarioTitle = "";
  var drafts = /* @__PURE__ */ new Map();
  var root = document.getElementById("app");
  function reset() {
    app = createSnackApp({ start: START, volunteers: VOLUNTEERS });
    feed = [];
    drafts.clear();
    scenarioTitle = "";
    app.chat.onMessage((msg) => feed.push({ kind: "msg", at: app.clock.now(), msg }));
    for (const [id, days] of PATTERNS) app.directory.setOfficeDays(id, days);
    app.directory.setPresenceRange("osl-5", "2026-11-02", "2026-11-06", { kind: "holiday" });
  }
  async function say(who, text) {
    const entry = { kind: "user", at: app.clock.now(), who, text };
    feed.push(entry);
    entry.reply = await app.commands.handle(who, text);
    return entry.reply;
  }
  function note(text) {
    feed.push({ kind: "note", at: app.clock.now(), text });
  }
  async function advance(ms) {
    const end = app.clock.now().getTime() + ms;
    while (app.clock.now().getTime() < end) {
      app.clock.advance(Math.min(15 * MINUTE, end - app.clock.now().getTime()));
      if (hrAutoApprove) app.hr.approveOlderThan(3 * DAY);
      await app.service.tick();
    }
  }
  async function advanceTo(iso) {
    await advance(new Date(iso).getTime() - app.clock.now().getTime());
  }
  async function active(officeId) {
    return app.store.findActive(officeId);
  }
  var SCENARIOS = {
    race: {
      title: "Two people tap \u201CYes\u201D at the same moment",
      async run() {
        note("Dag finds the Oslo box empty. Ada and Bj\xF8rn both see the channel post and tap \u201CYes\u201D within milliseconds.");
        await say("osl-4", "/snack empty");
        const r = await active("OSL");
        await Promise.all([say("osl-1", `/snack yes ${r.id}`), say("osl-2", `/snack yes ${r.id}`)]);
        note("Exactly one commit wins (compare-and-set on the refill version). The other is told not to buy.");
      }
    },
    silence: {
      title: "Nobody answers",
      async run() {
        note("The box is reported empty, and nobody answers their DM.");
        await say("osl-4", "/snack empty");
        for (let i = 0; i < 3; i++) await advance(2 * HOUR);
        note("After three unanswered 2-hour offers, the refill is opened to the whole #snacks-oslo channel.");
        await advance(4 * HOUR);
        note("Still nobody after 4 hours: the channel is re-posted and the office manager is alerted.");
      }
    },
    lapse: {
      title: "Buyer commits, then forgets",
      async run() {
        await say("osl-4", "/snack empty");
        const r = await active("OSL");
        await say(r.offer.to, `/snack yes ${r.id}`);
        note("The buyer has 24 hours. Fast-forward 18 hours\u2026");
        await advance(18 * HOUR);
        note("\u2026a reminder went out. Another 6 hours pass without a purchase.");
        await advance(6 * HOUR);
        note("The refill is handed to the next person and the budget reservation is released. The first buyer can still report a late purchase until someone else commits.");
      }
    },
    visitor: {
      title: "A Bengaluru volunteer visits Oslo for two weeks",
      async run() {
        note("Anil will be in Oslo for two weeks. One command covers the whole trip, with no daily check-ins.");
        await say("blr-1", "/snack visiting oslo 2026-11-02 2026-11-13");
        await say("osl-4", "/snack empty");
        await say("blr-3", "/snack empty");
        note("Anil is a candidate in Oslo (he is physically there) and is skipped in Bengaluru, even though he is usually in on weekdays. If he buys in Oslo it is charged to Oslo\u2019s NOK budget; HR pays him in INR.");
      }
    },
    budget: {
      title: "The monthly budget runs out",
      async run() {
        note("Five Oslo refills of 1 150 NOK use 5 750 of the 6 000 NOK budget\u2026");
        const buyers = ["osl-1", "osl-2", "osl-3", "osl-4", "osl-6"];
        for (const b of buyers) {
          await say("osl-4", "/snack empty");
          const r = await active("OSL");
          await say(b, `/snack yes ${r.id}`);
          await say(b, `/snack bought ${r.id} 1150 https://receipts/${r.id}.jpg chips, fruit`);
          await advance(4 * HOUR);
        }
        await say("osl-4", "/snack empty");
        note("Only 250 NOK is left, below a sensible minimum purchase (300 NOK), so the refill is put on hold and the office manager is told. Try \u201CJump to 1 Dec\u201D: it resumes automatically.");
      }
    },
    overLimit: {
      title: "A receipt above the limit",
      async run() {
        await say("osl-4", "/snack empty");
        const r = await active("OSL");
        await say(r.offer.to, `/snack yes ${r.id}`);
        await say(r.offer.to, `/snack bought ${r.id} 1480 https://receipts/${r.id}.jpg cake, coffee`);
        note("1 480 NOK is above the 1 200 NOK pre-approved limit. It counts as spent, but the HR claim waits for the office manager. Approve or reject it under \u201CBack office\u201D.");
      }
    },
    month: {
      title: "Simulate the whole of November",
      async run() {
        note("Simulating every working day of November at both offices: random empty boxes, some declines and timeouts, purchases within the typical range. HR approves claims after 3 days.");
        await simulateMonth();
        note("Done. The management report below now covers the whole month.");
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
  async function simulateMonth() {
    const rand = rng(42);
    const items = {
      OSL: ["chips", "fruit", "kvikk lunsj", "nuts", "cola", "knekkebr\xF8d"],
      BLR: ["samosa", "biscuits", "banana chips", "chikki", "juice", "fruit"]
    };
    for (let day = 2; day <= 30; day++) {
      const date = `2026-11-${String(day).padStart(2, "0")}`;
      await advanceTo(`${date}T07:30:00Z`);
      const weekday = (/* @__PURE__ */ new Date(`${date}T12:00:00Z`)).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      for (const office of app.directory.listOffices()) {
        if (rand() > 0.42 || await active(office.id)) continue;
        const locals = VOLUNTEERS.filter((v) => v.homeOfficeId === office.id);
        await say(locals[Math.floor(rand() * locals.length)].employeeId, `/snack empty ${office.id}`);
        for (let attempt = 0; attempt < 6; attempt++) {
          const r2 = await active(office.id);
          if (!r2 || r2.status !== "AWAITING_VOLUNTEER") break;
          const who = r2.offer?.to ?? locals[Math.floor(rand() * locals.length)].employeeId;
          const roll = rand();
          if (roll < 0.65) {
            await say(who, `/snack yes ${r2.id}`);
            break;
          }
          if (roll < 0.85) await say(who, `/snack no ${r2.id}`);
          else await advance(2 * HOUR);
        }
        const r = await active(office.id);
        if (r?.status !== "COMMITTED") continue;
        const buyer = r.commitment.buyer;
        const [lo, hi] = office.currency === "NOK" ? [350, 1150] : [600, 2900];
        const limit = r.commitment.spendLimit.minor / 100;
        const amount = Math.min(Math.round((lo + rand() * (hi - lo)) / 10) * 10, Math.floor(limit));
        const picked = items[office.id].filter(() => rand() < 0.4).join(", ") || items[office.id][0];
        await advance(HOUR);
        await say(buyer, `/snack bought ${r.id} ${amount} https://receipts/${r.id}.jpg ${picked}`);
      }
    }
    await advanceTo("2026-11-30T17:00:00Z");
  }
  function personName(id) {
    return app.directory.volunteer(id)?.name ?? ADMINS[id] ?? id;
  }
  function officeName(id) {
    return app.directory.office(id).name;
  }
  function statsFor(id, refills, now) {
    const bought = refills.filter((r) => r.purchase?.buyer === id);
    return {
      recent: bought.filter((r) => r.purchase.purchasedAt.getTime() >= now.getTime() - app.policy.fairnessWindowMs).length,
      owed: bought.filter((r) => ["NEEDS_APPROVAL", "PURCHASED", "CLAIM_SUBMITTED"].includes(r.status)).length
    };
  }
  function presenceKey(id, date) {
    const p = app.directory.presenceOn(id, date);
    if (!p) return "unknown";
    return p.kind === "office" ? `office:${p.officeId}` : p.kind;
  }
  function presenceLabel(key2) {
    if (key2.startsWith("office:")) return `In ${officeName(key2.slice(7))}`;
    return { unknown: "Unknown", remote: "Remote", holiday: "On holiday" }[key2] ?? key2;
  }
  function h(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function when(d, office) {
    return formatLocal(d, office.timeZone);
  }
  async function render() {
    const refills = await app.store.list();
    const now = app.clock.now();
    const [osl, blr] = app.directory.listOffices();
    const report = await app.monthlyReport(localMonth(now, osl.timeZone));
    root.innerHTML = `
    <section class="controls">
      <div class="clock">
        <div class="clock-main">${h(formatLocal(now, osl.timeZone))} <span>Oslo</span></div>
        <div class="clock-sub">${h(formatLocal(now, blr.timeZone))} Bengaluru</div>
      </div>
      <div class="btn-group" role="group" aria-label="Advance time">
        <button data-act="advance" data-ms="${15 * MINUTE}">+15 min</button>
        <button data-act="advance" data-ms="${2 * HOUR}">+2 h</button>
        <button data-act="advance" data-ms="${6 * HOUR}">+6 h</button>
        <button data-act="advance" data-ms="${DAY}">+1 day</button>
        <button data-act="jump-month">Jump to 1 Dec</button>
      </div>
      <label class="toggle"><input type="checkbox" data-act="hr-auto" ${hrAutoApprove ? "checked" : ""}/> HR approves claims after 3 days</label>
      <button class="ghost" data-act="reset">Reset</button>
    </section>

    <section class="scenarios">
      <span class="scenarios-label">Try a scenario</span>
      ${Object.entries(SCENARIOS).map(([k, s]) => `<button class="chip-btn ${scenarioTitle === s.title ? "on" : ""}" data-act="scenario" data-key="${k}">${h(s.title)}</button>`).join("")}
    </section>

    <div class="layout">
      <div class="col-main">
        ${officeCard(osl, refills, now)}
        ${officeCard(blr, refills, now)}
        ${backOffice(refills)}
        ${reportPanel(report)}
      </div>
      <aside class="col-feed">${feedPanel()}</aside>
    </div>`;
    const list = root.querySelector(".feed-list");
    if (list) list.scrollTop = list.scrollHeight;
  }
  function officeCard(office, refills, now) {
    const today = localDate(now, office.timeZone);
    const refill = refills.find((r) => r.officeId === office.id && ACTIVE_STATUSES.has(r.status));
    const pos = budgetPosition(office, localMonth(now, office.timeZone), refills);
    const ranked = rankCandidates({
      office,
      today,
      now,
      volunteers: app.directory.listVolunteers(),
      presenceOn: (id, d) => app.directory.presenceOn(id, d),
      refills,
      exclude: new Set(refill?.passedOver ?? []),
      policy: app.policy
    });
    const rank = new Map(ranked.map((c, i) => [c.employeeId, i + 1]));
    const busyElsewhere = new Set(refills.filter((r) => r.status === "COMMITTED" && r.officeId !== office.id).map((r) => r.commitment.buyer));
    const people = VOLUNTEERS.filter((v) => {
      const key2 = presenceKey(v.employeeId, today);
      return v.homeOfficeId === office.id || key2 === `office:${office.id}`;
    });
    const pct2 = (m) => Math.max(0, Math.min(100, m.minor / pos.budget.minor * 100));
    return `
  <section class="card office">
    <header class="office-head">
      <div>
        <h2>${h(office.name)} <small>${h(office.currency)} \xB7 ${h(office.channel)}</small></h2>
        <div class="box-line">${boxStatus(office, refill)}</div>
      </div>
      <button class="primary" data-act="empty" data-office="${office.id}" ${refill ? "disabled" : ""}>Report box empty</button>
    </header>

    <div class="budget" aria-label="Budget">
      <div class="bar">
        <span class="spent" style="width:${pct2(pos.spent)}%"></span><span class="reserved" style="width:${pct2(pos.reserved)}%"></span>
      </div>
      <div class="budget-legend">
        <span><i class="dot spent"></i>${h(format(pos.spent))} spent</span>
        <span><i class="dot reserved"></i>${h(format(pos.reserved))} reserved</span>
        <span class="${pos.remaining.minor < office.minPurchase.minor ? "low" : ""}"><b>${h(format(pos.remaining))}</b> left of ${h(format(pos.budget))} in ${h(pos.month)}</span>
      </div>
    </div>

    <table class="people">
      <thead><tr><th>Volunteer</th><th>Today</th><th>Usual days</th><th class="num">Refills (30 d)</th><th class="num">Owed</th><th>Who's asked next</th><th></th></tr></thead>
      <tbody>${people.map((v) => personRow(v, office, today, refill, refills, now, rank, busyElsewhere)).join("")}</tbody>
    </table>
  </section>`;
  }
  function boxStatus(office, r) {
    if (!r) return `<span class="pill ok">Stocked</span>`;
    switch (r.status) {
      case "AWAITING_VOLUNTEER":
        return r.offer?.to ? `<span class="pill warn">Empty</span> Asked <b>${h(personName(r.offer.to))}</b>, who has until ${h(when(r.offer.expiresAt, office))} to answer \xB7 ${r.id}` : `<span class="pill warn">Empty</span> Open to everyone in ${h(office.channel)} until ${h(when(r.offer?.expiresAt ?? /* @__PURE__ */ new Date(), office))}${r.escalated ? " \xB7 <b>manager alerted</b>" : ""} \xB7 ${r.id}`;
      case "COMMITTED":
        return `<span class="pill info">Being refilled</span> <b>${h(personName(r.commitment.buyer))}</b> is buying, up to ${h(format(r.commitment.spendLimit))}, by ${h(when(r.commitment.dueAt, office))} \xB7 ${r.id}`;
      case "ON_HOLD_BUDGET":
        return `<span class="pill bad">On hold</span> This month's budget is used up. Resumes automatically next month \xB7 ${r.id}`;
      default:
        return "";
    }
  }
  function personRow(v, office, today, r, refills, now, rank, busyElsewhere) {
    const id = v.employeeId;
    const key2 = presenceKey(id, today);
    const s = statsFor(id, refills, now);
    const days = app.directory.usualOfficeDays(id);
    const visitor = v.homeOfficeId !== office.id;
    const away = key2.startsWith("office:") && key2 !== `office:${office.id}`;
    let next;
    const n = rank.get(id);
    if (n !== void 0) next = n === 1 ? `<span class="pill info">1st</span>` : `${n}${n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
    else if (r?.passedOver.includes(id)) next = '<span class="muted">passed this time</span>';
    else if (key2 === "holiday" || key2 === "remote" || away) next = `<span class="muted">skipped: ${h(presenceLabel(key2).toLowerCase())}</span>`;
    else if (s.owed >= app.policy.maxOpenClaimsPerVolunteer) next = `<span class="muted">skipped: owed for ${s.owed} refills</span>`;
    else if (busyElsewhere.has(id) || r?.status === "COMMITTED" && r.commitment.buyer === id) next = '<span class="muted">buying</span>';
    else next = '<span class="muted">-</span>';
    const options = ["unknown", "office:OSL", "office:BLR", "remote", "holiday"].map((k) => `<option value="${k}" ${k === key2 ? "selected" : ""}>${h(k === "unknown" && days ? "Usual pattern" : presenceLabel(k))}</option>`).join("");
    return `
  <tr class="${away ? "away" : ""} ${r?.offer?.to === id ? "asked" : ""}">
    <td><b>${h(v.name)}</b>${visitor ? ` <span class="tag">from ${h(officeName(v.homeOfficeId))}</span>` : ""}</td>
    <td><select data-act="presence" data-who="${id}" data-office="${office.id}" aria-label="${h(v.name)} today">${options}</select></td>
    <td class="muted">${days ? days.map((d) => WEEKDAYS[d]).join(" ") : "-"}</td>
    <td class="num">${s.recent}</td>
    <td class="num">${s.owed || "-"}</td>
    <td>${next}</td>
    <td class="actions">${away ? "" : personActions(id, office, r)}</td>
  </tr>`;
  }
  function personActions(id, office, r) {
    if (!r) return "";
    if (r.status === "AWAITING_VOLUNTEER") {
      if (r.offer?.to === id) {
        return `<button class="small ok" data-act="cmd" data-who="${id}" data-cmd="/snack yes ${r.id}">Yes, I'll buy</button>
              <button class="small" data-act="cmd" data-who="${id}" data-cmd="/snack no ${r.id}">Can't today</button>`;
      }
      if (r.lapsedBuyer === id) return boughtForm(id, office, r, "Report late purchase");
      return `<button class="small" data-act="cmd" data-who="${id}" data-cmd="/snack yes ${r.id}">Step in</button>`;
    }
    if (r.status === "COMMITTED" && r.commitment.buyer === id) {
      return `${boughtForm(id, office, r, "Bought")}<button class="small" data-act="cmd" data-who="${id}" data-cmd="/snack release ${r.id}">Release</button>`;
    }
    return "";
  }
  function boughtForm(id, office, r, label) {
    const amountKey = `amount:${r.id}`;
    const itemsKey = `items:${r.id}`;
    const amount = drafts.get(amountKey) ?? (office.currency === "NOK" ? "845.50" : "2450");
    const items = drafts.get(itemsKey) ?? (office.currency === "NOK" ? "chips, fruit" : "samosa, biscuits");
    return `<span class="bought">
    <input class="amt" data-draft="${amountKey}" value="${h(amount)}" aria-label="Amount in ${office.currency}" />
    <input class="items" data-draft="${itemsKey}" value="${h(items)}" aria-label="Items" />
    <button class="small ok" data-act="bought" data-who="${id}" data-refill="${r.id}">${h(label)}</button>
  </span>`;
  }
  function backOffice(refills) {
    const approvals = refills.filter((r) => r.status === "NEEDS_APPROVAL");
    const claims = [...app.hr.claims.values()].reverse();
    const now = app.clock.now().getTime();
    return `
  <section class="card">
    <h2>Back office <small>office managers and the simulated HR system</small></h2>
    ${approvals.length ? approvals.map((r) => {
      const admin = app.directory.office(r.officeId).admins[0];
      return `<div class="approval"><span class="pill warn">Needs approval</span>
                <b>${h(personName(r.purchase.buyer))}</b> spent ${h(format(r.purchase.amount))} on ${r.id}, above the ${h(format(r.commitment?.spendLimit ?? app.directory.office(r.officeId).maxPurchase))} limit
                <span class="spacer"></span>
                <button class="small ok" data-act="cmd" data-who="${admin}" data-cmd="/snack approve ${r.id}">Approve as manager</button>
                <button class="small" data-act="cmd" data-who="${admin}" data-cmd="/snack reject ${r.id} not a snack refill">Reject</button></div>`;
    }).join("") : ""}
    ${claims.length ? `<table class="claims"><thead><tr><th>HR claim</th><th>Employee</th><th class="num">Amount</th><th>Description</th><th>Age</th><th>Status</th><th></th></tr></thead><tbody>
        ${claims.map(
      (c) => `<tr><td>${c.id}</td><td>${h(personName(c.request.employeeId))} <span class="muted">${h(c.request.employeeId)}</span></td>
              <td class="num">${h(c.request.amount)} ${c.request.currency}</td><td class="muted desc">${h(c.request.description)}</td>
              <td class="muted">${Math.floor((now - c.createdAt.getTime()) / DAY)} d</td>
              <td>${c.status.state === "PENDING" ? '<span class="pill">Pending</span>' : c.status.state === "APPROVED" ? '<span class="pill ok">Approved</span>' : '<span class="pill bad">Rejected</span>'}</td>
              <td class="actions">${c.status.state === "PENDING" ? `<button class="small ok" data-act="hr-approve" data-claim="${c.id}">Approve</button><button class="small" data-act="hr-reject" data-claim="${c.id}">Reject</button>` : ""}</td></tr>`
    ).join("")}</tbody></table>` : '<p class="muted empty">No claims yet. They appear here the moment a buyer reports a purchase.</p>'}
  </section>`;
  }
  function reportPanel(r) {
    const row = (o) => `
    <tr><td><b>${h(o.office)}</b></td><td class="num">${h(format(o.budget))}</td><td class="num">${h(format(o.spent))}</td>
    <td class="num">${o.utilisationPct}%</td><td class="num">${h(format(o.reimbursed))}</td><td class="num">${h(format(o.awaitingReimbursement))}</td>
    <td class="num">${o.refills}</td><td class="num">${o.avgHoursEmpty ?? "-"}</td><td class="items-cell">${h(o.topItems.slice(0, 3).map((t) => t.item).join(", ") || "-")}</td>
    <td class="num">${h(format(o.spentConverted))}</td></tr>`;
    return `
  <section class="card">
    <header class="row-between"><h2>Management report \xB7 ${h(r.month)} <small>one report, both offices</small></h2>
      <button class="small" data-act="post-report">Post to #snack-reports</button></header>
    <table class="report"><thead><tr><th>Office</th><th class="num">Budget</th><th class="num">Spent</th><th class="num">Used</th><th class="num">Reimbursed</th><th class="num">Awaiting</th><th class="num">Refills</th><th class="num">Hours empty</th><th>Top items</th><th class="num">In ${r.reportingCurrency}</th></tr></thead>
    <tbody>${r.offices.map(row).join("")}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${h(format(r.total.budget))}</td><td class="num">${h(format(r.total.spent))}</td><td class="num">${r.total.utilisationPct}%</td>
      <td class="num">${h(format(r.total.reimbursed))}</td><td class="num">${h(format(r.total.awaitingReimbursement))}</td><td colspan="3"></td><td class="num">${h(format(r.total.spent))}</td></tr></tfoot></table>
    <p class="muted fine">Each office is totalled exactly in its own currency; only the totals are converted, at the month's rate (1 INR = ${r.offices[1]?.rate} NOK). \u201CHours empty\u201D is the average time from \u201Creported empty\u201D to \u201Cbought\u201D.</p>
  </section>`;
  }
  function feedPanel() {
    const entries = feed.filter((e) => feedFilter === "all" || e.kind !== "msg" || (feedFilter === "channels" ? e.msg.kind === "channel" : e.msg.kind === "direct")).slice(-250);
    const people = [...VOLUNTEERS.map((v) => v.employeeId), ...Object.keys(ADMINS)];
    return `
  <section class="card feed">
    <header class="feed-head">
      <h2>Chat</h2>
      <div class="tabs" role="tablist">
        ${["all", "channels", "dms"].map((f) => `<button role="tab" class="${feedFilter === f ? "on" : ""}" data-act="filter" data-filter="${f}">${{ all: "Everything", channels: "Channels", dms: "Direct messages" }[f]}</button>`).join("")}
      </div>
    </header>
    <div class="feed-list">${entries.length ? entries.map(feedEntry).join("") : `<p class="muted empty">Pick a scenario above, or press \u201CReport box empty\u201D. Every message here is sent by the real bot logic through the simulated chat tool.</p>`}</div>
    <form class="composer" data-act="compose">
      <select data-act="acting-as" aria-label="Acting as">${people.map((p) => `<option value="${p}" ${p === actingAs ? "selected" : ""}>${h(personName(p))}</option>`).join("")}</select>
      <input name="cmd" data-draft="composer" placeholder="/snack help" value="${h(drafts.get("composer") ?? "")}" autocomplete="off" />
      <button class="primary small" type="submit">Send</button>
    </form>
  </section>`;
  }
  function feedEntry(e) {
    const t = `<time>${h(formatLocal(e.at, "Europe/Oslo").replace(/^\w+ /, ""))}</time>`;
    if (e.kind === "note") return `<div class="entry note">${t}<div>${h(e.text)}</div></div>`;
    if (e.kind === "user") {
      return `<div class="entry user">${t}<div><b>${h(personName(e.who))}</b> <code>${h(e.text)}</code>${e.reply ? `<div class="reply">\u21B3 ${h(e.reply.split("\n")[0])}</div>` : ""}</div></div>`;
    }
    const m = e.msg;
    const where = m.kind === "channel" ? `<span class="where ch">${h(m.to)}</span>` : `<span class="where dm">DM \u2192 ${h(personName(m.to))}</span>`;
    const buttons = m.actions.filter((a) => !a.command.includes("<")).map((a) => `<button class="small" data-act="cmd" data-who="${m.kind === "direct" ? m.to : ""}" data-cmd="${h(a.command)}">${h(a.label)}</button>`).join("");
    return `<div class="entry bot">${t}<div>${where}<div class="text">${h(m.text)}</div>${buttons ? `<div class="msg-btns">${buttons}</div>` : ""}</div></div>`;
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    document.body.classList.add("busy");
    try {
      await fn();
    } catch (e) {
      note(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
      document.body.classList.remove("busy");
      await render();
    }
  }
  root.addEventListener("click", (ev) => {
    const el = ev.target.closest("button[data-act]");
    if (!el) return;
    const d = el.dataset;
    switch (d.act) {
      case "advance":
        return void run(() => advance(Number(d.ms)));
      case "jump-month":
        return void run(async () => {
          if (app.clock.now() < /* @__PURE__ */ new Date("2026-11-30T23:15:00Z")) await advanceTo("2026-11-30T23:15:00Z");
          else await advance(DAY);
        });
      case "reset":
        history.replaceState(null, "", location.pathname);
        return void run(async () => reset());
      case "scenario":
        history.replaceState(null, "", `#scenario=${d.key}`);
        return void run(() => runScenario(d.key));
      case "empty":
        return void run(async () => {
          const office = app.directory.office(d.office);
          const reporter = VOLUNTEERS.find((v) => presenceKey(v.employeeId, localDate(app.clock.now(), office.timeZone)) === `office:${office.id}`) ?? VOLUNTEERS.find((v) => v.homeOfficeId === office.id);
          await say(reporter.employeeId, `/snack empty ${office.id}`);
        });
      case "cmd":
        return void run(async () => {
          await say(d.who || actingAs, d.cmd);
        });
      case "bought":
        return void run(async () => {
          const amount = (drafts.get(`amount:${d.refill}`) ?? root.querySelector(`[data-draft="amount:${d.refill}"]`)?.value ?? "").trim();
          const items = (drafts.get(`items:${d.refill}`) ?? root.querySelector(`[data-draft="items:${d.refill}"]`)?.value ?? "").trim();
          await say(d.who, `/snack bought ${d.refill} ${amount} https://receipts/${d.refill}.jpg ${items}`);
        });
      case "hr-approve":
        return void run(async () => {
          app.hr.approve(d.claim);
          note(`HR approved ${d.claim}. The bot picks this up on its next poll.`);
          await app.service.tick();
        });
      case "hr-reject":
        return void run(async () => {
          app.hr.reject(d.claim, "receipt is unreadable");
          note(`HR rejected ${d.claim}.`);
          await app.service.tick();
        });
      case "filter":
        feedFilter = d.filter;
        return void render();
      case "post-report":
        return void run(async () => {
          await app.sendMonthlyReport(localMonth(app.clock.now(), "Europe/Oslo"));
        });
    }
  });
  root.addEventListener("change", (ev) => {
    const el = ev.target;
    const d = el.dataset;
    if (d.act === "hr-auto") {
      hrAutoApprove = el.checked;
      return;
    }
    if (d.act === "acting-as") {
      actingAs = el.value;
      return;
    }
    if (d.act === "presence") {
      const who = d.who;
      const office = app.directory.office(d.office);
      const today = localDate(app.clock.now(), office.timeZone);
      void run(async () => {
        if (el.value === "unknown") {
          app.directory.clearPresence(who, today);
          note(`${personName(who)} is back to their usual pattern today.`);
        } else if (el.value.startsWith("office:")) await say(who, `/snack here ${el.value.slice(7)}`);
        else if (el.value === "remote") await say(who, "/snack remote");
        else await say(who, `/snack holiday ${today}`);
      });
    }
  });
  root.addEventListener("input", (ev) => {
    const el = ev.target;
    if (el.dataset.draft) drafts.set(el.dataset.draft, el.value);
  });
  root.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = (drafts.get("composer") ?? "").trim();
    if (!text) return;
    drafts.delete("composer");
    void run(async () => {
      await say(actingAs, text.startsWith("/snack") ? text : `/snack ${text}`);
    });
  });
  async function runScenario(key2) {
    const s = SCENARIOS[key2];
    if (!s) return;
    reset();
    scenarioTitle = s.title;
    note(`Scenario: ${s.title}`);
    await s.run();
  }
  reset();
  var fromHash = /^#scenario=(\w+)$/.exec(location.hash)?.[1];
  if (fromHash && SCENARIOS[fromHash]) void run(() => runScenario(fromHash));
  else void render();
})();
