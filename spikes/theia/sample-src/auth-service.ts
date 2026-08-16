export interface TokenStore {
    saveRefreshToken(userId: string, token: string): Promise<void>;
}

export class AuthService {
    constructor(private readonly tokenStore: TokenStore) {}

    async refreshSession(userId: string, refreshToken: string): Promise<void> {
        await this.rotateRefreshToken(userId, refreshToken);
    }

    async rotateRefreshToken(userId: string, token: string): Promise<void> {
        await this.tokenStore.saveRefreshToken(userId, token);
    }
}
