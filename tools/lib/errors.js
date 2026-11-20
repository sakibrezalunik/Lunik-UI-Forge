/**
 * An environment problem: the verification could not be carried out at all.
 * Always maps to exit code 3, never to a passing run.
 */
export class EnvironmentError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'EnvironmentError';
    this.details = details;
  }
}
