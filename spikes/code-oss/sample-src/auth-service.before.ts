export interface Database {
    save(refreshToken: string): Promise<void>;
    revoke(refreshToken: string): Promise<void>;
}

export class AuthService {
    constructor(private readonly database: Database) {}

    async refresh(refreshToken: string): Promise<void> {
        await this.validate(refreshToken);

        await this.database.save(refreshToken);
    }

    async logout(refreshToken: string): Promise<void> {
        await this.database.revoke(refreshToken);
    }

    private async validate(_refreshToken: string): Promise<void> {
        return Promise.resolve();
    }
}
