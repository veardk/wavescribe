// Colours for stderr output. Off when stderr is not a terminal, and NO_COLOR / FORCE_COLOR are
// honoured (Node's `hasColors()` reads both).

const enabled = (): boolean => !!process.stderr.isTTY && process.stderr.hasColors?.() === true;

const wrap = (open: number, close: number) => (s: string) => (enabled() ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
