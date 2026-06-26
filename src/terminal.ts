const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export const ansi = {
  clear: "\x1b[2J\x1b[H",
  enterAlt: "\x1b[?1049h",
  exitAlt: "\x1b[?1049l",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  defaultCursor: "\x1b[0 q",
  blinkingBarCursor: "\x1b[5 q",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reverse: "\x1b[7m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

export function moveCursor(row: number, column: number): string {
  return `\x1b[${row};${column}H`;
}

export function color(value: string, code: string): string {
  return `${code}${value}${ansi.reset}`;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  const raw = stripAnsi(value);
  if (raw.length <= width) return value;
  if (width <= 3) return raw.slice(0, width);
  return `${raw.slice(0, width - 3)}...`;
}

export function padRight(value: string, width: number): string {
  const truncated = truncate(value, width);
  const pad = Math.max(0, width - visibleLength(truncated));
  return `${truncated}${" ".repeat(pad)}`;
}

export function isPrintableInput(data: string): boolean {
  if (data.length === 0) return false;
  for (const char of data) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127 || (code >= 128 && code <= 159)) {
      return false;
    }
  }
  return true;
}

export function formatStatus(status: string): string {
  switch (status) {
    case "added":
    case "untracked":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "modified":
      return "M";
    default:
      return "?";
  }
}
