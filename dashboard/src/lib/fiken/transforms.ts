// Helpers for Fiken data: amount conversion, account ranges, VAT periods

/** Convert øre to NOK */
export function oreToNok(ore: number): number {
  return ore / 100;
}

/** Norwegian standard chart of accounts ranges */
export const ACCOUNT_RANGES = {
  income: { from: 3000, to: 3999 },
  costs: { from: 4000, to: 7999 },
  vat: { from: 2700, to: 2799 },
};

export function isIncomeAccount(accountNumber: string): boolean {
  const n = parseInt(accountNumber, 10);
  return n >= ACCOUNT_RANGES.income.from && n <= ACCOUNT_RANGES.income.to;
}

export function isCostAccount(accountNumber: string): boolean {
  const n = parseInt(accountNumber, 10);
  return n >= ACCOUNT_RANGES.costs.from && n <= ACCOUNT_RANGES.costs.to;
}

export function isVatAccount(accountNumber: string): boolean {
  const n = parseInt(accountNumber, 10);
  return n >= ACCOUNT_RANGES.vat.from && n <= ACCOUNT_RANGES.vat.to;
}

/** Format local date as YYYY-MM-DD (timezone-safe, no UTC conversion). month0 is 0-11. */
function fmtLocalDate(year: number, month0: number, day: number): string {
  const m = String(month0 + 1).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/** Norwegian VAT periods are bi-monthly: Jan-Feb, Mar-Apr, May-Jun, Jul-Aug, Sep-Oct, Nov-Dec */
export function currentVatPeriod(date: Date = new Date()): { number: number; startDate: string; endDate: string; label: string } {
  const month = date.getMonth();
  const year = date.getFullYear();
  const periodNumber = Math.floor(month / 2) + 1;
  const startMonth = (periodNumber - 1) * 2;
  const endMonth = startMonth + 1;
  const endDay = daysInMonth(year, endMonth);

  const monthNames = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];

  return {
    number: periodNumber,
    startDate: fmtLocalDate(year, startMonth, 1),
    endDate: fmtLocalDate(year, endMonth, endDay),
    label: `${monthNames[startMonth]}-${monthNames[endMonth]} ${year}`,
  };
}

export function monthBounds(date: Date = new Date()): { startDate: string; endDate: string } {
  const year = date.getFullYear();
  const month = date.getMonth();
  return { startDate: fmtLocalDate(year, month, 1), endDate: fmtLocalDate(year, month, daysInMonth(year, month)) };
}

export function ytdBounds(date: Date = new Date()): { startDate: string; endDate: string } {
  const year = date.getFullYear();
  return { startDate: fmtLocalDate(year, 0, 1), endDate: fmtLocalDate(year, date.getMonth(), date.getDate()) };
}
