/** Marks an in-flight Squirrel.Mac replacement for logging and e2e evidence. */
export function createUpdateQuitGate() {
  return {
    approveQuitForUpdate(): void {
      process.env.CLASH_UPDATE_INSTALLING = "1";
    },
  };
}
