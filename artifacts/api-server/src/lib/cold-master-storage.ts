/**
 * Provider-neutral cold-master boundary. R2 is deliberately not configured in
 * this environment, so callers receive an explicit failure instead of an
 * invented archival result.
 */
export interface ColdMasterStorage {
  archive(input: { organizationId: string; videoId: string; source: string }): Promise<{ storageKey: string }>;
}

export class UnconfiguredColdMasterStorage implements ColdMasterStorage {
  async archive(): Promise<{ storageKey: string }> {
    throw new Error("Cold-master storage is unconfigured");
  }
}

export const coldMasterStorage: ColdMasterStorage = new UnconfiguredColdMasterStorage();