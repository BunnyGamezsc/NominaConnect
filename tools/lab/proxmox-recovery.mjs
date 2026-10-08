export async function restoreCloneWithLeftoverCheck(run, { vmid, archive }) {
  try {
    await run("/usr/sbin/pct", ["restore", String(vmid), archive, "--storage", "local-lvm"], 600_000);
  } catch (restoreError) {
    try {
      await run("/usr/sbin/pct", ["config", String(vmid)]);
    } catch {
      throw restoreError;
    }
    throw new Error(
      `pct restore failed and VMID ${vmid} remains. Inspect the partial container and remove it before retrying.`,
      { cause: restoreError }
    );
  }
}
