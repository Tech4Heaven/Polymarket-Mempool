/** `0x123456…abcd` */
export function shortAddr(addr: string): string {
  if (addr.length < 14) {
    return addr;
  }
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

/** Shorten long decimal token id strings for display. */
export function shortId(id: string): string {
  if (id.length <= 14) {
    return id;
  }
  return `${id.slice(0, 4)}…${id.slice(-6)}`;
}
