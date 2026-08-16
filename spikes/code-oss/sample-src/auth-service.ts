export interface TokenStore {
    save(refreshToken: string): Promise<void>;
    revoke(refreshToken: string): Promise<void>;
}

export class AuthService {
    constructor(private readonly tokenStore: TokenStore) {}

    async refresh(refreshToken: string): Promise<void> {
        await this.validate(refreshToken);

        await this.tokenStore.save(refreshToken);
    }

    async logout(refreshToken: string): Promise<void> {
        await this.tokenStore.revoke(refreshToken);
    }

    private async validate(_refreshToken: string): Promise<void> {
        return Promise.resolve();
    }
}
