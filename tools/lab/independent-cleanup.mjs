export async function runIndependentCleanup(steps) {
  const failures = [];
  for (const [label, operation] of steps) {
    try {
      await operation();
    } catch (error) {
      failures.push(new Error(label, { cause: error }));
    }
  }
  return failures;
}
