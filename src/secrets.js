export async function ensureConnectionSecret(adapters, label, reference) {
  const { secretStore, prompts } = adapters;
  if (reference === undefined || secretStore === undefined) {
    return;
  }
  if (secretStore.has(reference)) {
    return;
  }
  secretStore.store(reference, await promptSecretValue(prompts, label));
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
