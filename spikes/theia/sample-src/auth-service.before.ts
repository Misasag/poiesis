export interface Database {
    saveRefreshToken(userId: string, token: string): Promise<void>;
}

export class AuthService {
    constructor(private readonly database: Database) {}

    async refreshSession(userId: string, refreshToken: string): Promise<void> {
        await this.rotateRefreshToken(userId, refreshToken);
    }

    async rotateRefreshToken(userId: string, token: string): Promise<void> {
        await this.database.saveRefreshToken(userId, token);
    }
}
