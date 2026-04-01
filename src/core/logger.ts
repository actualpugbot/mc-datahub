export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export function createConsoleLogger(verbose = false): Logger {
  return {
    info(message: string) {
      console.log(message);
    },
    warn(message: string) {
      console.warn(message);
    },
    error(message: string) {
      console.error(message);
    },
    debug(message: string) {
      if (verbose) {
        console.debug(message);
      }
    },
  };
}
