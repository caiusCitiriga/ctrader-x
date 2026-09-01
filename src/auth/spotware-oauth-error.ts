export class SpotwareOAuthError extends Error {
    constructor(
        message: string,
        public readonly errorCode?: string,
        public readonly httpStatus?: number,
    ) {
        super(message);
        this.name = 'SpotwareOAuthError';
    }
}
