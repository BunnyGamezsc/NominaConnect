import { randomUUID } from "node:crypto";
import { runAdoptionPass } from "./adoption.js";
import { loadProject } from "./config.js";
import { adoptPlatformDeployment, adoptServiceExposure, applyProviderReferenceChange } from "./adoption.js";
import { updateProject } from "./project-write.js";

/** Inspect providers without a write lock, then reload and apply observed changes under the shared project update lock. */
export async function runTrackingJob({ filesystem, projectDir, providerAdapters = {}, retryOptions = {}, commitRetryOptions = {} }) {
  let project;
  try {
    project = loadProject(filesystem, projectDir);
  } catch {
    return { changes: [], warnings: [], notices: [] };
  }

  const adoptionResult = await runAdoptionPass({ project, providerAdapters, retryOptions });
  const notices = [];

  if (adoptionResult.changes.length > 0 || adoptionResult.warnings.length > 0) {
    // Re-read rather than reusing the pre-adoption snapshot: the pass itself
    // can take a while, and the file on disk is the one being updated.
    await updateProject(filesystem, project.projectDirectory, (currentProject) => {
      let updatedConfig = currentProject.config;
      let updatedProviderReferences = currentProject.state.providerReferences ?? {};
      for (const change of adoptionResult.changes) {
        if (change.kind === "platform-deployed" || change.kind === "platform-changed") {
          updatedConfig = adoptPlatformDeployment(updatedConfig, change.platformKey, change.after);
        } else if (change.kind === "exposure-changed" || change.kind === "service-changed") {
          updatedConfig = adoptServiceExposure(updatedConfig, change.serviceId, change.after?.exposure ?? change.after);
        } else if (change.kind === "provider-reference-changed") {
          // Provider references are local state, never project configuration:
          // a provider-native locator belongs outside nomina.yaml (ADR-0003).
          updatedProviderReferences = applyProviderReferenceChange(updatedProviderReferences, change);
        }
      }

      const updatedState = {
        ...currentProject.state,
        providerReferences: updatedProviderReferences,
        tracking: {
          ...currentProject.state.tracking,
          notices: coalesceWarnings([
            ...currentProject.state.tracking.notices,
            ...adoptionResult.changes.map((change) => ({
              id: `nc_${randomUUID()}`,
              kind: change.kind,
              serviceName: change.serviceName,
              platformKey: change.platformKey,
              verified: change.verified,
              timestamp: change.timestamp,
              summary: formatChangeSummary(change)
            })),
            ...adoptionResult.warnings.map((warning) => ({
              id: `nc_${randomUUID()}`,
              kind: "verification-warning",
              serviceName: warning.serviceName,
              serviceId: warning.serviceId,
              platformKey: warning.platformKey,
              verified: false,
              timestamp: new Date().toISOString(),
              summary: warning.message
            }))
          ])
        }
      };

      return { ...currentProject, config: updatedConfig, state: updatedState };
    }, { maxRetries: 60, ...commitRetryOptions });
  }

  return {
    changes: adoptionResult.changes,
    warnings: adoptionResult.warnings,
    notices: [
      ...adoptionResult.changes.map((change) => ({
        kind: change.kind,
        serviceName: change.serviceName,
        verified: change.verified,
        summary: formatChangeSummary(change)
      })),
      ...adoptionResult.warnings.map((warning) => ({
        kind: "verification-warning",
        serviceName: warning.serviceName,
        verified: false,
        summary: warning.message
      }))
    ]
  };
}

export function formatChangeSummary(change) {
  if (change.kind === "platform-deployed") {
    return `${change.serviceName} deployment observed at ${change.after?.ip ?? "unknown ip"}.`;
  }
  if (change.kind === "platform-changed") {
    const fields = Object.keys(change.changes || {}).filter((k) => k !== "resources");
    if (change.changes?.resources !== undefined) {
      fields.push(...Object.keys(change.changes.resources).map((k) => `resources.${k}`));
    }
    return `${change.serviceName} ${fields.join(", ")} changed.`;
  }
  if (change.kind === "exposure-discovered") {
    return `Exposure for ${change.serviceName} discovered in provider.`;
  }
  if (change.kind === "exposure-changed") {
    const fields = Object.keys(change.changes || {});
    return `${change.serviceName} exposure ${fields.join(", ")} changed.`;
  }
  if (change.kind === "provider-reference-changed") {
    const target = change.integration === undefined
      ? change.serviceName
      : `${change.serviceName} (${change.integration})`;
    if (change.before === undefined) {
      return `Provider reference for ${target} recorded.`;
    }
    return `${target} changed in its provider; the managed provider reference was adopted.`;
  }
  if (change.kind === "upgrade-available") {
    return `An upgrade is available for ${change.serviceName} (${change.after}). Run 'nomina service upgrade ${change.serviceName}' to upgrade.`;
  }
  return `${change.serviceName} change adopted.`;
}

export function formatPendingNotices(notices) {
  if (notices.length === 0) {
    return "";
  }
  const grouped = coalesceWarnings(notices);
  const verified = grouped.filter((n) => n.verified);
  const unverified = grouped.filter((n) => !n.verified);
  const parts = [];
  if (verified.length > 0) {
    parts.push(`${verified.length} verified change(s):`);
    for (const notice of verified) {
      parts.push(`  - ${notice.summary}`);
    }
  }
  if (unverified.length > 0) {
    parts.push(`${unverified.length} unverified change(s) or warning(s):`);
    for (const notice of unverified) {
      const repeats = notice.occurrences > 1 ? ` (reported ${notice.occurrences} times)` : "";
      parts.push(`  - ${notice.summary}${repeats}`);
    }
  }
  return parts.join("\n");
}

// Only warnings coalesce. Distinct verified changes remain separate history
// entries, even when their human-readable summaries happen to match.
function coalesceWarnings(notices) {
  const result = [];
  const warnings = new Map();
  for (const notice of notices) {
    if (notice.kind !== "verification-warning") {
      result.push(notice);
      continue;
    }
    // Older notices did not carry serviceId. Name, platform and exact warning
    // text also identify their scope, so they can coalesce with newer notices.
    const key = JSON.stringify([notice.serviceName, notice.platformKey, notice.summary]);
    const previous = warnings.get(key);
    if (previous === undefined) {
      const grouped = { ...notice, firstTimestamp: notice.firstTimestamp ?? notice.timestamp, occurrences: notice.occurrences ?? 1 };
      warnings.set(key, grouped);
      result.push(grouped);
    } else {
      previous.occurrences += notice.occurrences ?? 1;
      previous.timestamp = notice.timestamp;
    }
  }
  return result;
}

export function formatChangesDetail(notices) {
  if (notices.length === 0) {
    return "No changes recorded.\n";
  }
  const lines = [];
  for (const notice of notices) {
    const verifiedLabel = notice.verified ? "verified" : "unverified";
    lines.push(`[${notice.timestamp}] ${notice.serviceName} (${notice.platformKey ?? "n/a"}) — ${verifiedLabel}`);
    const repeats = notice.occurrences > 1
      ? ` (reported ${notice.occurrences} times, first seen ${notice.firstTimestamp})` : "";
    lines.push(`  ${notice.summary}${repeats}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function clearPendingNotices(state) {
  return {
    ...state,
    tracking: {
      ...state.tracking,
      notices: []
    }
  };
}
