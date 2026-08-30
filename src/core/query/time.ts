import { CoreError } from "../contracts/errors.js";

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function invalidTime(fieldPath: string): CoreError {
  return new CoreError("VALIDATION_FAILED", "Invalid RFC3339 time", {
    violations: [{ field_path: fieldPath, rule_id: "schema.datetime" }],
  });
}

export function parseQueryTime(value: string, fieldPath: string): string {
  if (typeof value !== "string") throw invalidTime(fieldPath);
  const match = RFC3339.exec(value);
  if (!match) throw invalidTime(fieldPath);

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);

  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) throw invalidTime(fieldPath);

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw invalidTime(fieldPath);
  return new Date(timestamp).toISOString();
}
