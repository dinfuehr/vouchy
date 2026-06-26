import { spawnSync } from "node:child_process";

export interface ClipboardResult {
  ok: boolean;
  method: string | null;
}

interface ClipboardCommand {
  command: string;
  args: string[];
  method: string;
}

const CLIPBOARD_TIMEOUT_MS = 750;

export function copyToClipboard(text: string): ClipboardResult {
  if (isSshSession() && process.stderr.isTTY) {
    copyWithOsc52(text);
    return { ok: true, method: "OSC 52" };
  }

  for (const candidate of clipboardCommands()) {
    if (tryClipboardCommand(candidate, text)) {
      return { ok: true, method: candidate.method };
    }
  }

  if (process.stderr.isTTY) {
    copyWithOsc52(text);
    return { ok: true, method: "OSC 52" };
  }

  return { ok: false, method: null };
}

function clipboardCommands(): ClipboardCommand[] {
  if (process.platform === "darwin") {
    return [
      { command: "pbcopy", args: [], method: "pbcopy" },
      ...linuxClipboardCommands(),
    ];
  }

  if (process.platform === "win32") {
    return [
      { command: "clip.exe", args: [], method: "clip.exe" },
    ];
  }

  return [
    ...linuxClipboardCommands(),
    ...(isWsl() ? [{ command: "clip.exe", args: [], method: "clip.exe" }] : []),
  ];
}

function linuxClipboardCommands(): ClipboardCommand[] {
  const commands: ClipboardCommand[] = [];
  if (process.env.WAYLAND_DISPLAY != null && process.env.WAYLAND_DISPLAY.length > 0) {
    commands.push({ command: "wl-copy", args: [], method: "wl-copy" });
  }
  if (process.env.DISPLAY != null && process.env.DISPLAY.length > 0) {
    commands.push(
      { command: "xclip", args: ["-selection", "clipboard"], method: "xclip" },
      { command: "xsel", args: ["--clipboard", "--input"], method: "xsel" },
    );
  }
  return commands;
}

function tryClipboardCommand(candidate: ClipboardCommand, text: string): boolean {
  const result = spawnSync(candidate.command, candidate.args, {
    input: text,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: CLIPBOARD_TIMEOUT_MS,
    killSignal: "SIGTERM",
  });
  return result.status === 0 && result.error == null;
}

function isSshSession(): boolean {
  return (process.env.SSH_CONNECTION != null && process.env.SSH_CONNECTION.length > 0)
    || (process.env.SSH_TTY != null && process.env.SSH_TTY.length > 0);
}

function isWsl(): boolean {
  return (process.env.WSL_DISTRO_NAME != null && process.env.WSL_DISTRO_NAME.length > 0)
    || (process.env.WSL_INTEROP != null && process.env.WSL_INTEROP.length > 0);
}

function copyWithOsc52(text: string): void {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const sequence = `\x1b]52;c;${encoded}\x07`;
  if (process.env.TMUX != null && process.env.TMUX.length > 0) {
    process.stderr.write(`\x1bPtmux;\x1b${sequence}\x1b\\`);
    return;
  }

  process.stderr.write(sequence);
}
