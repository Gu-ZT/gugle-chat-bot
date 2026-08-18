import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';

interface PendingBinding {
  code: string;
  username: string;
}

interface GitHubBindings {
  bindings: Record<string, string[]>;
  pending: Record<string, PendingBinding>;
}

interface GitHubUserProfile {
  login: string;
  bio: string | null;
}

export class GitHubBindingManager {
  private static readonly FILE = path.resolve(process.cwd(), 'configs', 'github-bind.json');
  private static readonly CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  private static bindings: GitHubBindings | undefined;

  public static async bind(qqUserId: number, username: string): Promise<{ state: 'pending' | 'bound'; code?: string }> {
    const normalizedUsername = GitHubBindingManager.normalizeUsername(username);
    const bindings = GitHubBindingManager.load();
    const qqUserIdText = String(qqUserId);

    if (GitHubBindingManager.hasBinding(qqUserIdText, normalizedUsername)) {
      return { state: 'bound' };
    }

    const pendingKey = `${qqUserIdText}:${normalizedUsername.toLowerCase()}`;
    const pending = bindings.pending[pendingKey];
    if (!pending) {
      const code = GitHubBindingManager.generateCode();
      bindings.pending[pendingKey] = { code, username: normalizedUsername };
      GitHubBindingManager.save();
      return { state: 'pending', code };
    }

    const profile = await GitHubBindingManager.getUserProfile(pending.username);
    if (!profile.bio?.includes(pending.code)) {
      return { state: 'pending', code: pending.code };
    }

    const boundUsernames = bindings.bindings[qqUserIdText] || [];
    if (!boundUsernames.some(boundUsername => boundUsername.toLowerCase() === profile.login.toLowerCase())) {
      boundUsernames.push(profile.login);
      bindings.bindings[qqUserIdText] = boundUsernames;
    }
    delete bindings.pending[pendingKey];
    GitHubBindingManager.save();
    return { state: 'bound' };
  }

  public static isBoundUsername(username: string): boolean {
    const normalizedUsername = username.toLowerCase();
    return Object.values(GitHubBindingManager.load().bindings).some(usernames =>
      usernames.some(boundUsername => boundUsername.toLowerCase() === normalizedUsername)
    );
  }

  private static normalizeUsername(username: string): string {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
      throw new Error('GitHub 用户名格式无效');
    }
    return username;
  }

  private static generateCode(): string {
    let code = '';
    for (let index = 0; index < 12; index++) {
      code += GitHubBindingManager.CODE_ALPHABET[randomInt(GitHubBindingManager.CODE_ALPHABET.length)];
    }
    return code;
  }

  private static async getUserProfile(username: string): Promise<GitHubUserProfile> {
    try {
      const response = await axios.get<GitHubUserProfile>(`https://api.github.com/users/${username}`, {
        timeout: 10000,
        headers: { Accept: 'application/vnd.github+json' }
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new Error(`未找到 GitHub 用户 ${username}`);
      }
      throw new Error(`无法查询 GitHub 用户 ${username}`);
    }
  }

  private static hasBinding(qqUserId: string, username: string): boolean {
    return (GitHubBindingManager.load().bindings[qqUserId] || []).some(
      boundUsername => boundUsername.toLowerCase() === username.toLowerCase()
    );
  }

  private static load(): GitHubBindings {
    if (GitHubBindingManager.bindings) return GitHubBindingManager.bindings;

    fs.mkdirSync(path.dirname(GitHubBindingManager.FILE), { recursive: true });
    if (!fs.existsSync(GitHubBindingManager.FILE)) {
      GitHubBindingManager.bindings = { bindings: {}, pending: {} };
      GitHubBindingManager.save();
      return GitHubBindingManager.bindings;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(GitHubBindingManager.FILE, 'utf8')) as Partial<GitHubBindings>;
      GitHubBindingManager.bindings = {
        bindings: parsed.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
        pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {}
      };
    } catch (error) {
      throw new Error(`无法加载 GitHub 绑定数据：${error instanceof Error ? error.message : String(error)}`);
    }

    return GitHubBindingManager.bindings;
  }

  private static save(): void {
    fs.writeFileSync(GitHubBindingManager.FILE, `${JSON.stringify(GitHubBindingManager.bindings, null, 2)}\n`, 'utf8');
  }
}
