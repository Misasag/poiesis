export interface TokenStore {
    saveRefreshToken(userId: string, token: string): Promise<void>;
}

export class AuthService {
    constructor(private readonly tokenStore: TokenStore) {}

    async refreshSession(userId: string, refreshToken: string): Promise<void> {
        await this.rotateRefreshToken(userId, refreshToken);
    }

    logout(userId: string): void {
        // ログアウト対象のユーザーの認証情報だけを無効化するために userId を使う。
        // 失効処理は未実装
    }

    async rotateRefreshToken(userId: string, token: string): Promise<void> {
        await this.tokenStore.saveRefreshToken(userId, token);
    }
}
