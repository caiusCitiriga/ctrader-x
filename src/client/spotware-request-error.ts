export class SpotwareRequestError extends Error {
    constructor(
        message: string,
        public readonly errorCode?: string
    ) {
        super(message);
        this.name = 'SpotwareRequestError';
    }
}
