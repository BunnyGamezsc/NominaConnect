export function createClackPrompts(clack) {
  return {
    ask: async (question, fallback) => {
      const value = await clack.text({
        message: question,
        defaultValue: fallback,
        placeholder: fallback === undefined ? undefined : String(fallback)
      });
      if (clack.isCancel(value)) {
        throw new Error("Setup cancelled.");
      }
      const answer = value.trim();
      return answer || fallback;
    },
    select: async ({ message, options, initialValue }) => {
      const value = await clack.select({ message, options, initialValue });
      if (clack.isCancel(value)) {
        throw new Error("Setup cancelled.");
      }
      return value;
    },
    confirm: async ({ message, initialValue }) => {
      const value = await clack.confirm({ message, initialValue });
      if (clack.isCancel(value)) {
        throw new Error("Setup cancelled.");
      }
      return value;
    },
    info: (message) => {
      clack.log.info(message);
    },
    warn: (message) => {
      clack.log.warn(message);
    }
  };
}
