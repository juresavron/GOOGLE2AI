// The mirror: filling it, and deciding when it may be trusted to answer.
//
// db.ts owns the SQL; this owns the two judgements that make a mirror either useful or dangerous.
//
//   WHEN IS A DAY FINISHED? Search Console publishes a day roughly three days late and then keeps
//   revising it. A day stored while still provisional is a number that will change, so it is marked
//   not-final and re-fetched later. Getting this wrong does not produce an error — it produces
//   quietly stale numbers that disagree with Google's own UI, which is worse.
//
//   WHEN MAY THE MIRROR ANSWER? Only when every day in the requested range has been fetched AND
//   every one of them is final. A partially-synced range that answers from here silently under-
//   reports, and under-reporting looks exactly like a traffic drop. Anything less than complete
//   falls through to Google.
import type { Db } from './db.ts';
import type { AnalyticsRow, GSC } from './gsc.ts';

/**
 * A day is settled once Google has stopped revising it. Three days is the publishing lag; the two
 * extra are margin, because the lag is "roughly" three and the cost of waiting is one re-fetch
 * while the cost of being wrong is permanent: a provisional day marked final is never corrected.
 */
export const FINAL_AFTER_DAYS = 5;

/** Google keeps 16 months. Older than that can only ever come from here. */
export const GOOGLE_RETAINS_DAYS = 16 * 30;

const DAY_MS = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const daysBetween = (from: string, to: string) => Math.floor((parse(to).getTime() - parse(from).getTime()) / DAY_MS) + 1;

export const isFinal = (day: string, now = Date.now()): boolean => parse(day).getTime() <= now - FINAL_AFTER_DAYS * DAY_MS;

export interface SyncResult {
  days: number;
  rows: number;
  /** Days left unsynced because the budget ran out — not an error, just more to do next pass. */
  remaining: number;
}

export class Store {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Fetch one day and store it. One API call.
   *
   * `dims` never contains "date": the day is already fixed by the range, so asking Google to group
   * by it as well returns the same rows with a redundant column and makes the stored keys disagree
   * with every other day's.
   */
  async syncDay(accountId: string, gsc: GSC, property: string, dims: string, day: string, rowLimit = 25000): Promise<number> {
    const dimensions = dims.split(',').map((d) => d.trim()).filter((d) => d && d !== 'date');
    const rows = await gsc.searchAnalytics({
      siteUrl: property,
      startDate: day,
      endDate: day,
      dimensions,
      rowLimit,
      searchType: 'web',
      filters: [],
    });
    await this.db.putDay(accountId, dims, day, rows, isFinal(day));
    return rows.length;
  }

  /**
   * Bring a range up to date, newest first.
   *
   * Newest first because the most recent days are what anyone asks about, and a backfill that walks
   * forward from sixteen months ago leaves "last week" missing for hours. The budget is a hard cap
   * on API calls per pass: this shares a project-wide quota with every other tenant, so one
   * account's first backfill must not be able to spend all of it.
   */
  async backfill(accountId: string, gsc: GSC, property: string, dims: string, from: string, to: string, budget = 30): Promise<SyncResult> {
    // Counted separately rather than inferred from the page below. Fetching `budget + 1` days can
    // only distinguish "done" from "at least one more", so a `remaining` derived from it reports 1
    // with four hundred days outstanding — and a first backfill runs for days.
    const total = await this.db.countDaysToSync(accountId, dims, from, to);
    if (total === 0) return { days: 0, rows: 0, remaining: 0 };

    const batch = await this.db.daysToSync(accountId, dims, from, to, budget);
    let rows = 0;
    for (const day of batch) rows += await this.syncDay(accountId, gsc, property, dims, day);
    return { days: batch.length, rows, remaining: Math.max(0, total - batch.length) };
  }

  /**
   * Can the mirror answer this range on its own?
   *
   * Every day present and every day final. Deliberately strict: a range that is 90% synced would
   * answer with 90% of the clicks and no indication that anything was missing, and a reader — person
   * or model — would read that as a drop in traffic rather than a gap in the data.
   */
  async canAnswer(accountId: string, dims: string, from: string, to: string): Promise<boolean> {
    const want = daysBetween(from, to);
    if (want <= 0) return false;
    const { synced, final } = await this.db.coverage(accountId, dims, from, to);
    return synced >= want && final >= want;
  }

  async read(accountId: string, dims: string, from: string, to: string, limit: number): Promise<AnalyticsRow[]> {
    const rows = await this.db.readMirror(accountId, dims, from, to, limit);
    return rows.map((r) => ({
      keys: r.keys,
      clicks: r.clicks,
      impressions: r.impressions,
      // Recomputed rather than stored: CTR is exact from the two counts, and storing it would be a
      // third number that can disagree with them.
      ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
      position: r.position,
    }));
  }

  /**
   * The window worth keeping, given what Google still has.
   *
   * Everything older than Google's 16 months exists ONLY here, which is the whole point — so this
   * is the earliest date a backfill can still reach, not the earliest the mirror may hold.
   */
  earliestFetchable(now = Date.now()): string {
    return iso(new Date(now - GOOGLE_RETAINS_DAYS * DAY_MS));
  }

  stats(accountId: string) {
    return this.db.mirrorStats(accountId);
  }
}
