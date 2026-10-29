import { spawn } from 'node:child_process';

export type OpenFn = (url: string) => void;

/** Best effort: open a URL in the default browser. Never throws. */
export const openBrowser: OpenFn = (url) => {
  if (!/^https?:\/\//i.test(url)) return;
  let cmd: string;
  let args: string[];
  switch (process.platform) {
    case 'darwin':
      cmd = 'open';
      args = [url];
      break;
    case 'win32':
      cmd = 'cmd';
      args = ['/c', 'start', '""', url.replace(/&/g, '^&')];
      break;
    default:
      cmd = 'xdg-open';
      args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is always printed as well, so failing to open is fine.
  }
};
