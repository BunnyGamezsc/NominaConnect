import { randomUUID } from "node:crypto";
import { runAdoptionPass } from "./adoption.js";
import { loadProject, serializeProjectConfiguration } from "./config.js";
import { adoptPlatformDeployment } from "./adoption.js";

let writeQueue = Promise.resolve();

export function enqueueWrite(operation) {
  writeQueue = writeQueue.then(operation, operation);
  return writeQueue;
}

export async function runTrackingJob({ filesystem, projectDir, providerAdapters = {} }) {
  let project;
  try {
    project = loadProject(filesystem, projectDir);
  } catch {
    return { changes: [], warnings: [], notices: [] };
  }

  const adoptionResult = await runAdoptionPass({ project, providerAdapters });
  const notices = [];

  if (adoptionResult.changes.length > 0 || adoptionResult.warnings.length > 0) {
    await enqueueWrite(() => {
      let currentProject;
      try {
        currentProject = loadProject(filesystem, projectDir);
      } catch {
        return;
      }

      let updatedConfig = currentProject.config;
      for (const change of adoptionResult.changes) {
        if (change.kind === "platform-deployed" || change.kind === "platform-changed") {
          updatedConfig = adoptPlatformDeployment(updatedConfig, change.platformKey, change.after);
        }
      }

      const updatedState = {
        ...currentProject.state,
        tracking: {
          ...currentProject.state.tracking,
          notices: [
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
              platformKey: warning.platformKey,
              verified: false,
              timestamp: new Date().toISOString(),
              summary: warning.message
            }))
          ]
        }
      };

      filesystem.writeFile(
        currentProject.configPath,
        serializeProjectConfiguration(updatedConfig)
      );
      filesystem.writeFile(
        currentProject.statePath,
        `${JSON.stringify(updatedState, null, 2)}\n`
      );
    });
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
    return `${change.serviceName} deployment observed at ${change.after.ip ?? "unknown ip"}.`;
  }
  if (change.kind === "platform-changed") {
    const fields = Object.keys(change.changes).filter((k) => k !== "resources");
    if (change.changes.resources !== undefined) {
      fields.push(...Object.keys(change.changes.resources).map((k) => `resources.${k}`));
    }
    return `${change.serviceName} ${fields.join(", ")} changed.`;
  }
  if (change.kind === "exposure-discovered") {
    return `Exposure for ${change.serviceName} discovered in provider.`;
  }
  return `${change.serviceName} change adopted.`;
}

export function formatPendingNotices(notices) {
  if (notices.length === 0) {
    return "";
  }
  const verified = notices.filter((n) => n.verified);
  const unverified = notices.filter((n) => !n.verified);
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
      parts.push(`  - ${notice.summary}`);
    }
  }
  return parts.join("\n");
}

export function formatChangesDetail(notices) {
  if (notices.length === 0) {
    return "No changes recorded.\n";
  }
  const lines = [];
  for (const notice of notices) {
    const verifiedLabel = notice.verified ? "verified" : "unverified";
    lines.push(`[${notice.timestamp}] ${notice.serviceName} (${notice.platformKey ?? "n/a"}) — ${verifiedLabel}`);
    lines.push(`  ${notice.summary}`);
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
