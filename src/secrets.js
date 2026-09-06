export async function ensureConnectionSecret(adapters, label, reference, options = {}) {
  const { secretStore, prompts } = adapters;
  if (reference === undefined || secretStore === undefined) {
    return;
  }
  if (secretStore.has(reference)) {
    return;
  }
  const directSecret = typeof options === "string" ? options : options?.secret;
  const envKey = `NOMINA_SECRET_${label.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const envSecret = process.env[envKey] ?? process.env.NOMINA_SECRET;
  const secretValue = directSecret ?? envSecret;
  if (secretValue !== undefined && String(secretValue).trim() !== "") {
    secretStore.store(reference, String(secretValue).trim());
    return;
  }
  secretStore.store(reference, await promptSecretValue(prompts, label));
}

export async function updateConnectionSecret(adapters, label, reference, options = {}) {
  const { secretStore, prompts } = adapters;
  if (reference === undefined) {
    throw new Error(`No connection secret reference for ${label}.`);
  }
  if (secretStore === undefined) {
    throw new Error("Secret store is unavailable. Run nomina as root on the Proxmox host.");
  }
  const directSecret = typeof options === "string" ? options : options?.secret;
  const envKey = `NOMINA_SECRET_${label.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const envSecret = process.env[envKey] ?? process.env.NOMINA_SECRET;
  const secretValue = directSecret ?? envSecret;
  const newValue = (secretValue !== undefined && String(secretValue).trim() !== "")
    ? String(secretValue).trim()
    : await promptSecretValue(prompts, label);
  secretStore.store(reference, newValue);
}

async function promptSecretValue(prompts, label) {
  const question = `Connection secret for ${label}`;
  if (prompts?.secret !== undefined || prompts?.ask !== undefined) {
    while (true) {
      const answer = prompts.secret !== undefined
        ? await prompts.secret(question)
        : await prompts.ask(question);
      if (answer !== undefined && String(answer).trim() !== "") {
        return String(answer).trim();
      }
      if (prompts.warn !== undefined) {
        prompts.warn("A connection secret value is required.");
      }
    }
  }
  throw new Error(`No connection secret is stored for ${label}. Run nomina from an interactive terminal to enter it.`);
}
