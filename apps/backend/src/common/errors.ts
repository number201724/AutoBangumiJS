/** Mirrors Python's ValueError for repository-layer validation failures. */
export class ValueError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ValueError';
  }
}
