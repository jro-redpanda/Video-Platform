import { resolveTxt } from "node:dns/promises";

export interface DomainDnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

/** The sole production DNS boundary. Routes must never call this module. */
export const nodeDomainDnsResolver: DomainDnsResolver = { resolveTxt };

export async function resolveExactTxt(resolver: DomainDnsResolver, name: string, expected: string, timeoutMs = 5_000) {
  let timer: NodeJS.Timeout | undefined;
  try {
    const records = await Promise.race([
      resolver.resolveTxt(name),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("dns_timeout")), timeoutMs); }),
    ]);
    return records.some((parts) => parts.join("") === expected);
  } finally {
    if (timer) clearTimeout(timer);
  }
}