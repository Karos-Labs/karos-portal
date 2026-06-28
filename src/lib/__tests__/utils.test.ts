import { describe, it, expect } from "vitest";
import { formatDate, formatDateTime, relativeTime, initials, domainFromEmail } from "../utils";

describe("formatDate", () => {
  it("returns em-dash for null", () => {
    expect(formatDate(null)).toBe("—");
  });

  it("returns em-dash for undefined", () => {
    expect(formatDate(undefined)).toBe("—");
  });

  it("returns em-dash for an invalid date string", () => {
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("formats a valid epoch millis timestamp", () => {
    const result = formatDate(new Date("2024-01-15").getTime());
    expect(result).toMatch(/Jan/);
    expect(result).toMatch(/2024/);
  });

  it("formats a Date object", () => {
    const result = formatDate(new Date("2023-07-04"));
    expect(result).toMatch(/Jul/);
    expect(result).toMatch(/2023/);
  });

  it("formats a date string", () => {
    const result = formatDate("2025-03-20");
    expect(result).toMatch(/Mar/);
    expect(result).toMatch(/2025/);
  });
});

describe("formatDateTime", () => {
  it("returns em-dash for null", () => {
    expect(formatDateTime(null)).toBe("—");
  });

  it("returns em-dash for undefined", () => {
    expect(formatDateTime(undefined)).toBe("—");
  });

  it("returns em-dash for NaN date", () => {
    expect(formatDateTime("garbage")).toBe("—");
  });

  it("includes month and time components for a valid timestamp", () => {
    const result = formatDateTime(new Date("2024-06-01T14:30:00").getTime());
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/:/);
  });
});

describe("relativeTime", () => {
  it("returns em-dash for null", () => {
    expect(relativeTime(null)).toBe("—");
  });

  it("returns em-dash for undefined", () => {
    expect(relativeTime(undefined)).toBe("—");
  });

  it("returns em-dash for invalid date", () => {
    expect(relativeTime("not-a-date")).toBe("—");
  });

  it("returns 'just now' for timestamps less than 30 seconds old", () => {
    // Math.round(diff/60000) < 1 only when diff < 30 000 ms
    expect(relativeTime(Date.now() - 10_000)).toBe("just now");
    expect(relativeTime(Date.now() - 25_000)).toBe("just now");
  });

  it("returns minutes ago for timestamps 1–59 minutes old", () => {
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe("5m ago");
    expect(relativeTime(Date.now() - 30 * 60_000)).toBe("30m ago");
  });

  it("returns hours ago for timestamps 1–23 hours old", () => {
    expect(relativeTime(Date.now() - 3 * 3_600_000)).toBe("3h ago");
    expect(relativeTime(Date.now() - 12 * 3_600_000)).toBe("12h ago");
  });

  it("returns days ago for timestamps 1–29 days old", () => {
    expect(relativeTime(Date.now() - 7 * 86_400_000)).toBe("7d ago");
    expect(relativeTime(Date.now() - 29 * 86_400_000)).toBe("29d ago");
  });

  it("falls back to formatDate for timestamps 30+ days old", () => {
    const result = relativeTime(Date.now() - 45 * 86_400_000);
    // Should NOT be a relative string — should be a month-based date
    expect(result).not.toMatch(/ago/);
    expect(result).toMatch(/\d{4}/); // contains a year
  });
});

describe("initials", () => {
  it("returns ? for null", () => {
    expect(initials(null)).toBe("?");
  });

  it("returns ? for undefined", () => {
    expect(initials(undefined)).toBe("?");
  });

  it("returns ? for an empty string", () => {
    expect(initials("")).toBe("?");
  });

  it("extracts initials from a two-word name", () => {
    expect(initials("John Doe")).toBe("JD");
  });

  it("extracts the single initial from a one-word name", () => {
    expect(initials("Alice")).toBe("A");
  });

  it("caps at two initials for longer names", () => {
    expect(initials("John Michael Doe")).toBe("JM");
  });

  it("uppercases the result", () => {
    expect(initials("alice bob")).toBe("AB");
  });
});

describe("domainFromEmail", () => {
  it("returns null for null", () => {
    expect(domainFromEmail(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(domainFromEmail(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(domainFromEmail("")).toBeNull();
  });

  it("returns null when there is no @ sign", () => {
    expect(domainFromEmail("notanemail")).toBeNull();
  });

  it("extracts the domain from a valid email", () => {
    expect(domainFromEmail("user@example.com")).toBe("example.com");
  });

  it("lowercases the domain", () => {
    expect(domainFromEmail("User@EXAMPLE.COM")).toBe("example.com");
  });

  it("handles subdomains", () => {
    expect(domainFromEmail("me@mail.karoslabs.com")).toBe("mail.karoslabs.com");
  });
});
